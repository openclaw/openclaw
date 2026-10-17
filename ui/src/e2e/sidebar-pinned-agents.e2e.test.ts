import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Pinned agent sidebar" });
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "research", name: "Research and competitive intelligence", identity: { emoji: "🔬" } },
  ],
};
const assistantReply =
  "The release notes are ready for review. The next step is checking the examples.";

suite.define(() => {
  it("loads saved agent and session pins alongside existing session rows", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const legacyKey = "agent:research:legacy-notes";
        await page.addInitScript(
          ({ key, legacySessionKey }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarAgentsMode: "roster",
                pinnedAgentIds: ["main"],
                railShortcuts: [`session:${legacySessionKey}`],
              }),
            );
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            legacySessionKey: legacyKey,
          },
        );
        await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [
            sessionRow("agent:main:main", "Harbor chat", 30),
            sessionRow(legacyKey, "Legacy notes", 20),
          ],
          methodResponses: { "agents.list": agentsList },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator('[data-pinned-agent="main"]').waitFor();
        await sidebar.getByRole("link", { name: "Legacy notes", exact: true }).waitFor();
        expect(await sidebar.locator('[data-agent-group="research"]').count()).toBe(1);

        await page.goto(`${suite.server.baseUrl}sessions`);
        await waitForControlUiRoute(page, { routeId: "sessions" });
        await page.locator(".session-data-row").filter({ hasText: "Legacy notes" }).waitFor();
        expect(await sidebar.locator('[data-pinned-agent="main"]').count()).toBe(1);
      },
    );
  });

  it.each([1440, 1366, 768, 390])(
    "keeps row actions and pinned cards accessible at %s px",
    async (width) => {
      await suite.withPage(
        {
          locale: "en-US",
          viewport: { width, height: width === 390 ? 844 : 900 },
          hasTouch: width === 390,
        },
        async ({ page }) => {
          await page.addInitScript(
            (key) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" })),
            controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          );
          await installMockGateway(page, {
            sessions: [
              {
                key: "agent:main:main",
                agentId: "main",
                isMain: true,
                kind: "direct",
                updatedAt: 30,
                lastMessagePreview: "A newer user question",
                lastAssistantMessage: { text: assistantReply, timestamp: 20 },
              },
              {
                key: "agent:main:working-session",
                agentId: "main",
                isMain: false,
                kind: "direct",
                updatedAt: 25,
                hasActiveRun: true,
                status: "running",
              },
            ],
            methodResponses: {
              "agents.list": agentsList,
              "chat.startup": {
                agentsList,
                messages: [],
                metadata: { models: [] },
                sessionId: "main-session",
                thinkingLevel: null,
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiRoute(page, { routeId: "chat" });
          const drawerToggle = page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first();
          if (
            await page
              .locator(".shell")
              .evaluate((element) => element.classList.contains("shell--mobile-nav"))
          ) {
            await drawerToggle.press("Enter");
            await waitForMobileSidebarDrawerOpen(page);
          }
          const sidebar = page.locator("openclaw-app-sidebar:visible");
          const header = sidebar.locator('[data-agent-group="main"] .sidebar-agent-roster__header');
          const row = header.locator(".sidebar-agent-roster__row");
          const menu = header.getByRole("button", { name: "Options for Harbor" });
          await row.waitFor({ state: "visible" });
          expect(await row.getAttribute("title")).toBeNull();
          expect(await header.locator("a").count()).toBe(1);
          expect(
            await header.locator(".sidebar-agent-roster__avatar .session-glyph__ring").count(),
          ).toBe(1);
          expect(await sidebar.locator("[data-agent-collapse]").count()).toBe(0);
          expect(
            await sidebar
              .locator(
                ".sidebar-agent-roster__signals .sidebar-child-session-toggle__count, .sidebar-agent-roster__signals .session-glyph__ring",
              )
              .count(),
          ).toBe(0);
          expect(await sidebar.locator("[data-agent-group] .sidebar-recent-session").count()).toBe(
            0,
          );
          const longNameRow = sidebar.locator(
            '[data-agent-group="research"] .sidebar-agent-roster__row',
          );
          await page.mouse.move(-1, -1);
          const restingPadding = await longNameRow.evaluate(
            (element) => getComputedStyle(element).paddingInlineEnd,
          );
          await longNameRow.hover();
          const hoverPadding = await longNameRow.evaluate(
            (element) => getComputedStyle(element).paddingInlineEnd,
          );
          expect(restingPadding).toBe(width === 390 ? "32px" : "0px");
          expect(hoverPadding).toBe("32px");
          for (const state of ["hover", "focus"] as const) {
            if (state === "hover") {
              await row.hover();
            } else {
              await page.mouse.move(-1, -1);
              await menu.focus();
            }
            expect(
              await header
                .locator(".sidebar-agent-roster__actions")
                .evaluate((element) => getComputedStyle(element).opacity),
            ).toBe("1");
            const rowBounds = (await row.boundingBox())!;
            const bounds = (await menu.boundingBox())!;
            const headerBounds = (await header.boundingBox())!;
            expect(bounds.y + bounds.height / 2).toBeCloseTo(rowBounds.y + rowBounds.height / 2, 1);
            expect(bounds.x).toBeGreaterThanOrEqual(headerBounds.x);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(
              headerBounds.x + headerBounds.width,
            );
            expect(bounds.y).toBeGreaterThanOrEqual(headerBounds.y);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(
              headerBounds.y + headerBounds.height,
            );
            if (state === "focus") {
              expect(await menu.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
                "solid",
              );
            }
            await captureSidebarUiProof(suite, page, `row-${width}-${state}.png`);
          }
          await menu.press("ArrowDown");
          const viewSessions = sidebar.getByRole("menuitem", { name: "Sessions", exact: true });
          const settings = sidebar.getByRole("menuitem", { name: "Settings", exact: true });
          const deleteAgent = sidebar.getByRole("menuitem", { name: "Delete", exact: true });
          expect(await sidebar.getByRole("menuitem", { name: "Create new session" }).count()).toBe(
            0,
          );
          expect(await viewSessions.locator("svg").count()).toBe(1);
          expect(await settings.locator("svg").count()).toBe(1);
          expect(await deleteAgent.locator("svg").count()).toBe(1);
          for (const item of [viewSessions, settings, deleteAgent]) {
            expect(await item.locator("svg").evaluate((icon) => getComputedStyle(icon).width)).toBe(
              "16px",
            );
          }
          expect(await sidebar.getByRole("menuitem", { name: "Collapse others" }).count()).toBe(0);
          const menuLabels = await sidebar.getByRole("menuitem").allTextContents();
          expect(menuLabels.findIndex((label) => label.trim() === "Settings") + 1).toBe(
            menuLabels.findIndex((label) => label.trim() === "Delete"),
          );
          expect(await deleteAgent.getAttribute("data-variant")).toBe("danger");
          await captureSidebarUiProof(suite, page, `menu-${width}.png`);
          await sidebar.getByRole("menuitem", { name: "Pin", exact: true }).click();
          const pinned = sidebar.locator('[data-pinned-agent="main"]');
          const link = pinned.getByRole("link", { name: "Harbor", exact: true });
          await link.waitFor({ state: "visible" });
          expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await sidebar.locator('[data-agent-group="main"]').count()).toBe(0);
          expect(await sidebar.locator('[data-agent-group="research"]').isVisible()).toBe(true);
          expect(await pinned.locator(".sidebar-agent-roster__preview").count()).toBe(0);
          expect(
            await pinned.locator(".sidebar-pinned-agent__avatar .session-glyph__ring").count(),
          ).toBe(1);
          const pinnedMenu = pinned.getByRole("button", { name: "Options for Harbor" });
          await pinnedMenu.hover();
          expect(
            await pinnedMenu.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).toBe("rgba(0, 0, 0, 0)");
          if (width !== 390) {
            expect(await pinnedMenu.evaluate((element) => getComputedStyle(element).color)).toBe(
              await link.evaluate((element) => getComputedStyle(element).color),
            );
          }
          await captureSidebarUiProof(suite, page, `pinned-action-${width}-hover.png`);
          const card = pinned.locator(".tooltip-surface[popover]:popover-open");
          const content = pinned.locator(".sidebar-pinned-agent__card");
          for (const state of ["hover", "focus"] as const) {
            await page.mouse.move(-1, -1);
            await link.evaluate((element) => element.blur());
            await expect.poll(() => card.count()).toBe(0);
            if (state === "hover") {
              await page.mouse.move(-1, -1);
              await link.hover();
            } else {
              await page.mouse.move(-1, -1);
              await pinned.getByRole("button", { name: "Options for Harbor" }).focus();
              await page.keyboard.press("Shift+Tab");
              expect(await link.evaluate((element) => element === document.activeElement)).toBe(
                true,
              );
            }
            await card.waitFor({ state: "visible" });
            await content.waitFor({ state: "visible" });
            expect(await content.textContent()).toContain(assistantReply);
            expect(await content.textContent()).not.toContain("A newer user question");
            expect(await link.getAttribute("aria-describedby")).toBeTruthy();
            const bounds = (await card.boundingBox())!;
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            await captureSidebarUiProof(suite, page, `pin-${width}-${state}.png`);
            await page.keyboard.press("Escape");
            await expect.poll(() => card.count()).toBe(0);
            expect(await sidebar.isVisible()).toBe(true);
          }
          await pinnedMenu.press("ArrowDown");
          expect(
            await sidebar.getByRole("menuitem", { name: "Settings", exact: true }).count(),
          ).toBe(1);
          await sidebar.getByRole("menuitem", { name: "Unpin", exact: true }).click();
          await row.waitFor({ state: "visible" });
          expect(await sidebar.locator("[data-pinned-agent]").count()).toBe(0);
          await header.getByRole("button", { name: "Options for Harbor" }).press("ArrowDown");
          await sidebar.getByRole("menuitem", { name: "Settings", exact: true }).click();
          await waitForControlUiRoute(page, {
            routeId: "agents",
            pathname: "/settings/agents/main",
          });
        },
      );
    },
  );
});
