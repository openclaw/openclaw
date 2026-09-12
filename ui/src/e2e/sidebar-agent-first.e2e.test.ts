import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent-first sidebar geometry" });
const imageAvatar =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Engineering" },
    { id: "research", name: "Research", identity: { emoji: "🔬" } },
    { id: "writing", name: "Writing", identity: { avatarUrl: imageAvatar } },
  ],
};
const sessionRow = (
  id: string,
  label: string,
  extra: Partial<GatewaySessionRow & { updatedAt: number }> = {},
): GatewaySessionRow & { updatedAt: number } => ({
  key: `agent:main:${id}`,
  kind: "direct",
  agentId: "main",
  label,
  updatedAt: 100,
  ...extra,
});
const sessionRows = [
  sessionRow("project", "Project next steps"),
  sessionRow("weekly", "Weekly review"),
  sessionRow("parent", "Implement the navigation sidebar without losing independent outcomes", {
    lastMessagePreview: "A preview must not create a second line in team mode.",
  }),
  sessionRow("child", "Check rendering", { spawnedBy: "agent:main:parent" }),
  sessionRow("grandchild", "Compare deeply nested layouts with long labels", {
    spawnedBy: "agent:main:child",
    hasActiveRun: true,
    status: "running",
    unread: true,
    startedAt: Date.now() - 3_000,
  }),
  sessionRow("failure", "Review failed checks", {
    spawnedBy: "agent:main:parent",
    status: "failed",
    endedAt: 100,
    lastRunError: "Geometry mismatch",
  }),
  sessionRow("queued", "Queued follow-up", { hasActiveRun: true, status: "queued" }),
  sessionRow("private", "Private planning", { incognito: true }),
  sessionRow("automation", "Daily review", { hasAutomation: true }),
];
const sessions: SessionsListResult = {
  ts: 100,
  path: "",
  count: sessionRows.length,
  defaults: { model: null, modelProvider: null, contextTokens: null },
  sessions: sessionRows,
};

suite.define(() => {
  it.each([
    { mode: "light", width: 258, touch: false },
    { mode: "light", width: 334, touch: false },
    { mode: "dark", width: 286, touch: false },
    { mode: "light", width: 334, touch: true },
  ] as const)(
    "keeps recursive indicators right-aligned and names readable in $mode at $width px (touch=$touch)",
    async ({ mode, width, touch }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
          colorScheme: mode,
          hasTouch: touch,
        },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, prefs }) => {
              localStorage.setItem(key, JSON.stringify(prefs));
              localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
              localStorage.setItem(
                "openclaw:control-ui:community-invite",
                JSON.stringify({ dismissedAtMs: Date.now() }),
              );
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              prefs: {
                sidebarAgentsMode: "roster",
                navWidth: width,
                themeMode: mode,
              },
            },
          );
          await installMockGateway(page, {
            sessions: sessionRows,
            methodResponses: {
              "agents.list": agentsList,
              "agent.identity.get": {
                cases: agentsList.agents.map((agent) => ({
                  match: { agentId: agent.id },
                  response: {
                    agentId: agent.id,
                    name: agent.name,
                    emoji: agent.identity?.emoji,
                    avatar: agent.identity?.avatarUrl ?? "",
                  },
                })),
              },
              "chat.startup": {
                agentsList,
                messages: [],
                metadata: { models: [] },
                sessionId: "main-session",
                thinkingLevel: null,
              },
              "sessions.list": sessions,
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiRoute(page, { routeId: "chat" });
          const sidebar = page.locator("openclaw-app-sidebar");
          const group = sidebar.locator('[data-agent-group="main"]');
          const parent = group.locator('[data-session-key="agent:main:parent"]');
          await parent.waitFor({ state: "visible" });
          expect(
            await sidebar.evaluate((el) => el.parentElement?.getBoundingClientRect().width),
          ).toBe(width);
          const workspaceName = sidebar.locator(
            ".sidebar-workspace-header .sidebar-agent-card__name-text",
          );
          expect(await workspaceName.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          const headerControls = await sidebar
            .locator(".sidebar-brand__actions .sidebar-brand__header-control")
            .evaluateAll((elements) =>
              elements.map((el) => {
                const rect = el.getBoundingClientRect();
                return { x: rect.x, width: rect.width, height: rect.height };
              }),
            );
          expect(headerControls).toHaveLength(4);
          for (const [index, control] of headerControls.entries()) {
            expect(control.width).toBeCloseTo(28, 4);
            expect(control.height).toBeCloseTo(28, 4);
            expect(control.x).toBeCloseTo(headerControls[0]!.x + index * 28, 4);
          }
          for (const [id, label] of [
            ["project", "Project next steps"],
            ["weekly", "Weekly review"],
          ]) {
            const title = group.locator(
              `[data-session-key="agent:main:${id}"] .sidebar-recent-session__name`,
            );
            expect(await title.textContent()).toBe(label);
            expect.soft(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          }
          await group.locator('[data-agent-collapse="main"]').click();
          await page.locator("body").click({ position: { x: 1000, y: 800 } });
          const name = group.locator(".sidebar-agent-roster__copy > span");
          const nameWidth = (await name.boundingBox())?.width;
          await group.locator(".sidebar-agent-roster__header").hover();
          expect(await name.textContent()).toBe("Engineering");
          expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          expect((await name.boundingBox())?.width).toBe(nameWidth);
          expect(await group.locator(".sidebar-agent-roster__signals").isVisible()).toBe(false);
          await group.locator('[data-agent-collapse="main"]').click();
          await group.locator('[data-child-session-toggle="agent:main:parent"]').click();
          await group.locator('[data-child-session-toggle="agent:main:child"]').click();
          await group
            .locator('[data-session-key="agent:main:grandchild"]')
            .waitFor({ state: "visible" });
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(touch);
          expect(await group.locator(".identity-avatar__agent-face").count()).toBe(1);
          expect(
            await sidebar
              .locator(
                '[data-agent-group="research"] .sidebar-agent-roster__avatar .identity-avatar__text',
              )
              .getAttribute("data-avatar"),
          ).toContain("🔬");
          expect(
            await sidebar
              .locator('[data-agent-group="writing"] .sidebar-agent-roster__avatar img')
              .getAttribute("src"),
          ).toBe(imageAvatar);
          await page.locator("body").click({ position: { x: 1000, y: 800 } });
          const geometry = () =>
            group.evaluate((element) => {
              const avatar = element
                .querySelector(".sidebar-agent-roster__avatar")!
                .getBoundingClientRect();
              const header = element
                .querySelector(".sidebar-agent-roster__header")!
                .getBoundingClientRect();
              const rows = ["parent", "child", "grandchild"].map((id) => {
                const row = element.querySelector(`[data-session-key="agent:main:${id}"]`)!;
                const title = row
                  .querySelector(".sidebar-recent-session__name")!
                  .getBoundingClientRect();
                const state = row
                  .querySelector(".sidebar-session-team-state")
                  ?.getBoundingClientRect();
                return {
                  left: title.left,
                  right: row.getBoundingClientRect().right,
                  stateLeft: state?.left,
                  stateRight: state?.right,
                  titleRight: title.right,
                  height: row.getBoundingClientRect().height,
                };
              });
              return {
                avatarLeft: avatar.left,
                avatarWidth: avatar.width,
                headerHeight: header.height,
                rows,
              };
            });
          const beforeFocus = await geometry();
          expect(beforeFocus.avatarWidth).toBe(36);
          expect(beforeFocus.headerHeight).toBe(48);
          expect(beforeFocus.rows[0]!.left).toBeCloseTo(beforeFocus.avatarLeft, 1);
          expect(beforeFocus.rows[1]!.left - beforeFocus.rows[0]!.left).toBeCloseTo(16, 1);
          expect(beforeFocus.rows[2]!.left - beforeFocus.rows[1]!.left).toBeCloseTo(16, 1);
          for (const row of beforeFocus.rows) {
            expect(row.right).toBeCloseTo(beforeFocus.rows[0]!.right, 1);
            expect(row.height).toBe(touch ? 44 : 32);
            if (row.stateLeft !== undefined) {
              expect(row.titleRight).toBeLessThanOrEqual(row.stateLeft);
              expect(row.stateRight).toBeCloseTo(row.right - (touch ? 96 : 0), 1);
            } else if (!touch) {
              expect(row.titleRight).toBeCloseTo(row.right, 1);
            }
          }
          for (const caret of await group
            .locator(".sidebar-child-session-toggle__icon svg")
            .all()) {
            expect(
              await caret.evaluate((el) => ({
                width: el.getBoundingClientRect().width,
                animation: getComputedStyle(el).animationName,
              })),
            ).toEqual({ width: 12, animation: "none" });
          }
          const add = group.locator(".sidebar-agent-roster__new");
          const actions = group.locator(".sidebar-agent-roster__actions");
          await page.mouse.move(1000, 800);
          await page.locator("body").click({ position: { x: 1000, y: 800 } });
          expect(await actions.evaluate((element) => getComputedStyle(element).opacity)).toBe(
            touch ? "1" : "0",
          );
          await group.locator(".sidebar-agent-roster__row").focus();
          expect(await actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
          expect(await geometry()).toEqual(beforeFocus);
          expect(await add.getAttribute("href")).toBe("/new?agent=main");
          await sidebar.locator(".sidebar-brand .sidebar-new-session-menu button").click();
          const menuFace = sidebar.locator(
            '.sidebar-brand .sidebar-new-session-menu [value="main"] .identity-avatar__agent-face',
          );
          await menuFace.waitFor();
          await expect.poll(async () => (await menuFace.boundingBox())?.width).toBe(36);
          await page.keyboard.press("Escape");
          await captureSidebarUiProof(
            suite,
            page,
            `agent-first-${mode}-${width}-${touch ? "touch" : "pointer"}.png`,
          );
          await group.locator('[data-child-session-toggle="agent:main:parent"]').click();
          await expect
            .poll(() => group.locator('[data-session-key="agent:main:child"]').count())
            .toBe(0);
          await page.locator("body").click({ position: { x: 1000, y: 800 } });
          const collapsedSlots = parent.locator(".sidebar-session-team-state");
          const collapsedBounds = (await collapsedSlots.boundingBox())!;
          expect(collapsedBounds.x + collapsedBounds.width).toBeCloseTo(
            beforeFocus.rows[0]!.right - (touch ? 96 : 0),
            1,
          );
          expect(
            await collapsedSlots.locator(".sidebar-child-session-toggle__count").textContent(),
          ).toBe("2");
          expect(await collapsedSlots.locator(".session-unread-dot").count()).toBe(1);
          expect(await collapsedSlots.locator('[data-session-attention="error"]').count()).toBe(1);
          await group.locator('[data-agent-collapse="main"]').click();
          await expect.poll(() => parent.count()).toBe(0);
          expect(
            await group
              .locator('.sidebar-agent-roster__signals [data-session-attention="error"]')
              .count(),
          ).toBe(1);
          expect(
            await group.locator(".sidebar-agent-roster__signals .session-glyph__ring").count(),
          ).toBe(0);
          expect(
            await group.locator('.sidebar-agent-roster__signals [aria-label="Unread"]').count(),
          ).toBe(1);
          const summary = group.locator(
            ".sidebar-agent-roster__signals .sidebar-session-team-state",
          );
          const summaryBounds = (await summary.boundingBox())!;
          expect(summaryBounds.x + summaryBounds.width).toBeCloseTo(beforeFocus.rows[0]!.right, 1);
          await captureSidebarUiProof(suite, page, `agent-first-${mode}-${width}-collapsed.png`);
        },
      );
    },
  );
});
