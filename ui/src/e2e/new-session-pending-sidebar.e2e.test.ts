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
    "replaces the naming blob when title generation is %s",
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

  it.each(["chip", "roster"] as const)(
    "selects a visible provisional row in its %s destination without admitting it and removes it on rejection",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, sidebarAgentsMode }) =>
              localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode })),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              sidebarAgentsMode: mode,
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
          await oldRow.locator('.sidebar-recent-session__link[aria-current="page"]').waitFor();
          await navigateInApp(page, "new-session", "?agent=main");
          await page
            .locator(".new-session-page__message")
            .fill("Review release readiness and outstanding fixes");
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          await gateway.waitForRequest("sessions.create");
          await page.locator("openclaw-pending-session-create .chat-pane__header").waitFor();
          const provisional = page.locator(".sidebar-recent-session--creating");
          await expect.poll(() => provisional.count()).toBe(1);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const sessions = page.locator(".sidebar-shell__body");
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("body"),
              [sessions, provisional, page.locator(".chat-pane__header")],
              { animations: "disabled", elements: [sessions] },
            );
            await writeFile(
              path.join(suite.artifactDir, `pending-session-${mode}.png`),
              frame.elements[0]!.png,
            );
          }
          // The handoff occupies the slot its admitted row will take, not a detached
          // row above the list and its agent header.
          const destination =
            mode === "roster"
              ? '.sidebar-sessions [data-agent-group="main"]'
              : ".sidebar-sessions .sidebar-recent-sessions";
          expect(
            await page.locator(destination + " .sidebar-recent-session--creating").count(),
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
          const blob = provisional.locator(".session-title-placeholder > span");
          expect(
            await blob.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).not.toBe("rgba(0, 0, 0, 0)");
          expect(await blob.evaluate((element) => getComputedStyle(element).animationName)).toBe(
            "session-title-wave",
          );
          await page.emulateMedia({ reducedMotion: "reduce" });
          expect(await blob.evaluate((element) => getComputedStyle(element).animationName)).toBe(
            "none",
          );
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
          await oldRow.locator('[aria-current="page"]').waitFor();
        },
      );
    },
  );
});
