import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent-first sidebar geometry" });
const imageAvatar =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Engineering" },
    { id: "research", name: "Research and competitive intelligence", identity: { emoji: "🔬" } },
    { id: "writing", name: "Writing", identity: { avatarUrl: imageAvatar } },
  ],
};
const rows: Array<GatewaySessionRow & ControlUiSessionFixture> = [
  {
    key: "agent:main:project",
    agentId: "main",
    kind: "direct",
    updatedAt: 100,
    lastAssistantMessage: {
      text: "I've set up the template, but it still needs a final review before sharing with the team.",
      timestamp: 90,
    },
  },
  {
    key: "agent:main:working",
    agentId: "main",
    kind: "direct",
    updatedAt: 99,
    hasActiveRun: true,
    status: "running",
  },
  {
    key: "agent:main:failure",
    agentId: "main",
    kind: "direct",
    updatedAt: 98,
    status: "failed",
    lastRunError:
      "Preflight compaction required but failed: agent tool caller authority is no longer active",
  },
];
const sessions: SessionsListResult = {
  ts: 100,
  path: "",
  count: rows.length,
  defaults: { model: null, modelProvider: null, contextTokens: null },
  sessions: rows,
};

suite.define(() => {
  it.each([
    { mode: "light", width: 258, touch: false },
    { mode: "light", width: 334, touch: false },
    { mode: "dark", width: 286, touch: false },
    { mode: "light", width: 334, touch: true },
  ] as const)(
    "keeps agent-only rows readable in $mode at $width px (touch=$touch)",
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
              localStorage.setItem(
                "openclaw:control-ui:community-invite:v2",
                JSON.stringify({ dismissedAtMs: Date.now() }),
              );
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              prefs: { sidebarAgentsMode: "roster", navWidth: width, themeMode: mode },
            },
          );
          await installMockGateway(page, {
            sessions: rows,
            methodResponses: {
              "agents.list": agentsList,
              "agent.identity.get": {
                cases: agentsList.agents.map(({ id, name, identity }) => ({
                  match: { agentId: id },
                  response: {
                    agentId: id,
                    name,
                    emoji: identity?.emoji,
                    avatar: identity?.avatarUrl ?? "",
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
          const main = sidebar.locator('[data-agent-group="main"]');
          const roster = (part: string) => main.locator(`.sidebar-agent-roster__${part}`);
          const row = roster("row");
          const attention = roster('signals [data-session-attention="error"]');
          await main.waitFor({ state: "visible" });
          expect(await sidebar.locator(".sidebar-agent-roster__group").count()).toBe(3);
          expect(await sidebar.locator("[data-agent-collapse]").count()).toBe(0);
          expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(0);
          expect(
            await page.locator(".shell-nav").evaluate((el) => el.getBoundingClientRect().width),
          ).toBe(width + 52);

          await expect
            .poll(() => roster("preview").textContent())
            .toContain("I've set up the template");
          expect(
            await Promise.all([
              roster("avatar .session-glyph--running").count(),
              roster("signals .session-glyph__ring").count(),
              attention.count(),
            ]),
          ).toEqual([1, 0, 1]);
          const avatar = (agent: string) =>
            sidebar.locator(`[data-agent-group="${agent}"] .sidebar-agent-roster__avatar`);
          expect(
            await avatar("research").locator("[data-avatar]").getAttribute("data-avatar"),
          ).toContain("🔬");
          expect(await avatar("writing").locator("img").getAttribute("src")).toBe(imageAvatar);

          const headerLocator = roster("header");
          const right = (box: { x: number; width: number }) => box.x + box.width;
          const center = (box: { y: number; height: number }) => box.y + box.height / 2;
          await page.mouse.move(640, 880);
          const restingHeader = (await headerLocator.boundingBox())!;
          const restingIcon = (await attention.boundingBox())!;
          const copy = (await roster("copy").boundingBox())!;
          expect(restingHeader.height).toBe(44);
          expect(Math.abs(center(restingIcon) - center(restingHeader))).toBeLessThanOrEqual(1);
          expect(restingIcon.x).toBeGreaterThanOrEqual(right(copy));
          expect(right(restingIcon)).toBeLessThanOrEqual(right(restingHeader));

          if (!touch) {
            await attention.hover();
            const tooltip = main.locator(".tooltip-surface[popover]:popover-open");
            await expect
              .poll(() => tooltip.textContent())
              .toContain("caller authority is no longer active");
            const icon = (await attention.boundingBox())!;
            const surface = (await tooltip.boundingBox())!;
            expect(surface.x).toBeGreaterThanOrEqual(right(icon));
            expect(surface.y).toBeLessThan(center(icon));
            expect(surface.y + surface.height).toBeGreaterThan(center(icon));
            await page.mouse.move(640, 880);
            await tooltip.waitFor({ state: "hidden" });
          }

          const plainRow = sidebar.locator(
            '[data-agent-group="research"] .sidebar-agent-roster__row',
          );
          const expectPadding = async (target: typeof row, value: string) =>
            expect(await target.evaluate((el) => getComputedStyle(el).paddingRight)).toBe(value);
          await expectPadding(plainRow, touch ? "32px" : "0px");
          await expectPadding(row, "0px");
          if (!touch) {
            await plainRow.hover();
            await expectPadding(plainRow, "32px");
            await headerLocator.hover();
            await expectPadding(row, "0px");
          }
          const header = (await headerLocator.boundingBox())!;
          const actions = (await roster("actions").boundingBox())!;
          const icon = (await attention.boundingBox())!;
          expect(right(actions)).toBeLessThanOrEqual(right(header));
          expect(right(icon)).toBeLessThanOrEqual(actions.x);
          expect(Math.abs(center(icon) - center(header))).toBeLessThanOrEqual(1);
        },
      );
    },
  );
});
