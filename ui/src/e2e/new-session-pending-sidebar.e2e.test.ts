import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
  controlUiSessionPath,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each(["named", "failed"])(
    "replaces the title placeholder when title generation is %s",
    async (outcome) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const key = "agent:main:dashboard:title-settlement";
        const pending = {
          key,
          sessionId: "title-settlement",
          kind: "direct",
          updatedAt: 1,
          titlePending: true,
          status: "done",
          hasActiveRun: false,
        };
        const gateway = await installMockGateway(page, { sessionKey: key, sessions: [pending] });
        await page.goto(new URL(controlUiSessionPath(key), suite.server.baseUrl).href);
        const sidebar = page.locator('.sidebar-recent-session[data-session-key="' + key + '"]');
        const header = page.locator(".chat-pane__header");
        await sidebar.locator(".session-title-placeholder").waitFor();
        await header.locator(".session-title-placeholder").waitFor();
        const settled = {
          ...pending,
          updatedAt: 2,
          titlePending: false,
          ...(outcome === "named" ? { displayName: "Release readiness" } : {}),
        };
        await gateway.setSessionsListResponse({ sessions: [settled] });
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "chat.title",
          sessionKey: key,
          agentId: "main",
          session: settled,
        });
        const expected = outcome === "named" ? "Release readiness" : "New session";
        await expect
          .poll(() => sidebar.locator(".sidebar-recent-session__name").textContent())
          .toBe(expected);
        await expect
          .poll(() => header.locator(".chat-pane__session-title-text").textContent())
          .toBe(expected);
        expect(await sidebar.locator(".session-title-placeholder").count()).toBe(0);
        expect(await header.locator(".session-title-placeholder").count()).toBe(0);
      });
    },
  );

  it.each([
    { destination: "chip", mode: "chip", pinned: false },
    { destination: "roster", mode: "roster", pinned: false },
    { destination: "pinned agent", mode: "roster", pinned: true },
  ] as const)(
    "shows a provisional row only where the admitted row appears ($destination) and restores the draft on rejection",
    async ({ destination, mode, pinned }) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, sidebarAgentsMode, pinnedAgentIds }) =>
              localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode, pinnedAgentIds })),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              sidebarAgentsMode: mode,
              pinnedAgentIds: pinned ? ["main"] : [],
            },
          );
          const old = {
            key: "agent:main:planning",
            sessionId: "planning",
            kind: "direct",
            label: "Weekly planning",
            updatedAt: 1,
          };
          const gateway = await installMockGateway(page, { sessionKey: old.key, sessions: [old] });
          await page.goto(new URL(controlUiSessionPath(old.key), suite.server.baseUrl).href);
          const oldRow = page.locator('[data-session-key="' + old.key + '"]');
          if (mode === "chip") {
            await oldRow.locator('.sidebar-recent-session__link[aria-current="page"]').waitFor();
          } else if (pinned) {
            await page.locator('[data-pinned-agent="main"]').waitFor();
            expect(await oldRow.count()).toBe(0);
          } else {
            await page.locator('.sidebar-agent-roster__group[data-agent-group="main"]').waitFor();
            expect(await oldRow.count()).toBe(0);
          }
          await navigateInApp(page, "new-session", "?agent=main");
          await page
            .locator(".new-session-page__message")
            .fill("Review release readiness and outstanding fixes");
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          await gateway.waitForRequest("sessions.create");
          await page.locator("openclaw-pending-session-create .chat-pane__header").waitFor();
          const provisional = page.locator(".sidebar-recent-session--creating");
          if (mode === "chip") {
            await expect.poll(() => provisional.count()).toBe(1);
          } else {
            // The agent-only roster never lists the admitted session, so a handoff row
            // there would flash under the agent header and vanish on admission.
            await page.locator('[data-agent-id="main"]').waitFor();
            expect(await provisional.count()).toBe(0);
          }
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const sessions = page.locator(".sidebar-shell__body");
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("body"),
              [sessions, page.locator(".chat-pane__header")],
              { animations: "disabled", elements: [sessions] },
            );
            await writeFile(
              path.join(suite.artifactDir, `pending-session-${destination.replace(" ", "-")}.png`),
              frame.elements[0]!.png,
            );
          }
          if (mode === "chip") {
            // The handoff occupies the slot its admitted row will take, not a detached
            // row above the list.
            expect(
              await page
                .locator(
                  ".sidebar-sessions .sidebar-recent-sessions .sidebar-recent-session--creating",
                )
                .count(),
            ).toBe(1);
            const titleInset = (row: typeof provisional) =>
              row
                .locator(".sidebar-recent-session__text")
                .evaluate((element) => Math.round(element.getBoundingClientRect().left));
            expect(await titleInset(provisional)).toBe(await titleInset(oldRow));
            expect(await provisional.locator('[aria-current="page"]').count()).toBe(1);
            expect(await oldRow.locator('[aria-current="page"]').count()).toBe(0);
            expect(await provisional.locator("button, a[href]").count()).toBe(0);
            expect(await provisional.locator(".session-title-placeholder").count()).toBe(1);
          }
          const bars = page.locator(".session-title-placeholder > span");
          expect(await bars.count()).toBe(mode === "chip" ? 2 : 1);
          for (const bar of await bars.all()) {
            const style = await bar.evaluate((element) => {
              const computed = getComputedStyle(element);
              return {
                radius: computed.borderRadius,
                transform: computed.transform,
                background: computed.backgroundColor,
                animation: getComputedStyle(element, "::after").animationName,
              };
            });
            expect(style.radius).toBe("3px");
            expect(style.transform).toBe("none");
            expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
            expect(style.animation).toBe("shimmer");
          }
          await page.emulateMedia({ reducedMotion: "reduce" });
          for (const bar of await bars.all()) {
            expect(
              await bar.evaluate((element) => getComputedStyle(element, "::after").animationName),
            ).toBe("none");
          }
          expect(await page.locator(".chat-pane__header .session-title-placeholder").count()).toBe(
            1,
          );
          expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
          await gateway.rejectDeferred("sessions.create", {
            code: "UNAVAILABLE",
            message: "Synthetic admission refused",
          });
          await expect
            .poll(() => page.locator(".new-session-page__message").inputValue())
            .toBe("Review release readiness and outstanding fixes");
          expect(await provisional.count()).toBe(0);
          expect(await page.locator('.sidebar-recent-session [aria-current="page"]').count()).toBe(
            0,
          );
          await navigateInApp(page, "chat");
          await waitForCommittedChatRoute(page);
          if (mode === "chip") {
            await oldRow.locator('[aria-current="page"]').waitFor();
          } else if (pinned) {
            expect(await page.locator('[data-pinned-agent="main"]').count()).toBe(1);
          } else {
            expect(
              await page.locator('.sidebar-agent-roster__group[data-agent-group="main"]').count(),
            ).toBe(1);
          }
        },
      );
    },
  );
});
