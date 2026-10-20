import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
  controlUiSessionPath,
  pollText,
  pollValue,
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
        const sidebar = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
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
        await pollText(sidebar.locator(".sidebar-recent-session__name")).toBe(expected);
        await pollText(header.locator(".chat-pane__session-title-text")).toBe(expected);
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
    async ({ mode, pinned }) => {
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
          const currentDestination =
            mode === "chip"
              ? oldRow.locator('.sidebar-recent-session__link[aria-current="page"]')
              : page.locator(
                  pinned
                    ? '[data-pinned-agent="main"]'
                    : '.sidebar-agent-roster__group[data-agent-group="main"]',
                );
          await currentDestination.waitFor();
          if (mode !== "chip") {
            expect(await oldRow.count()).toBe(0);
          }
          await navigateInApp(page, "new-session", "?agent=main");
          const message = page.locator(".new-session-page__message");
          const prompt = "Review release readiness and outstanding fixes";
          await message.fill(prompt);
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          await gateway.waitForRequest("sessions.create");
          await page.locator("openclaw-pending-session-create .chat-pane__header").waitFor();
          const provisional = page.locator(".sidebar-recent-session--creating");
          if (mode === "chip") {
            await expect.poll(() => provisional.count()).toBe(1);
          } else {
            // Agent-only rosters must not flash a row they will not retain after admission.
            await page.locator('[data-agent-id="main"]').waitFor();
            expect(await provisional.count()).toBe(0);
          }
          if (mode === "chip") {
            // The handoff occupies the slot its admitted row will take.
            const handoffSlot = page.locator(
              ".sidebar-sessions .sidebar-recent-sessions .sidebar-recent-session--creating",
            );
            expect(await handoffSlot.count()).toBe(1);
            const titleInset = (row: typeof provisional) =>
              row
                .locator(".sidebar-recent-session__text")
                .evaluate((element) => Math.round(element.getBoundingClientRect().left));
            expect(await titleInset(provisional)).toBe(await titleInset(oldRow));
            // Row spacing, not section spacing: admission swaps rows without moving the rest.
            const bounds = (row: typeof provisional) =>
              row.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
            const [pendingBox, oldBox] = [await bounds(provisional), await bounds(oldRow)];
            expect(Math.round(oldBox.top - pendingBox.bottom)).toBe(2);
            expect(await provisional.locator('[aria-current="page"]').count()).toBe(1);
            expect(await oldRow.locator('[aria-current="page"]').count()).toBe(0);
            expect(await provisional.locator("button, a[href]").count()).toBe(0);
            expect(await provisional.locator(".session-title-placeholder").count()).toBe(1);
          }
          const bars = provisional
            .locator(".session-title-placeholder > span")
            .or(
              page
                .locator("openclaw-pending-session-create .session-title-placeholder > span")
                .filter({ visible: true }),
            );
          expect(await bars.count()).toBe(mode === "chip" ? 2 : 1);
          for (const bar of await bars.all()) {
            const style = await bar.evaluate((element) => {
              const { borderRadius, transform, backgroundColor } = getComputedStyle(element);
              return {
                radius: borderRadius,
                transform,
                background: backgroundColor,
                animation: getComputedStyle(element, "::after").animationName,
              };
            });
            expect(style).toMatchObject({ radius: "3px", transform: "none", animation: "shimmer" });
            expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
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
          await pollValue(message).toBe(prompt);
          expect(await provisional.count()).toBe(0);
          expect(await page.locator('.sidebar-recent-session [aria-current="page"]').count()).toBe(
            0,
          );
          await navigateInApp(page, "chat");
          await waitForCommittedChatRoute(page);
          if (mode === "chip") {
            await oldRow.locator('[aria-current="page"]').waitFor();
          } else {
            expect(await currentDestination.count()).toBe(1);
          }
        },
      );
    },
  );
});
