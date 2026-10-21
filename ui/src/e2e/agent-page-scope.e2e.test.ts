import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Control UI agent page scope",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const pageOptions = (recordVideo = false) => ({
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1440 },
  ...(recordVideo && captureUiProof
    ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
    : {}),
});
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-page-scope");
  }
});
function requestParams(request: { params?: unknown }): Record<string, unknown> {
  return request.params && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {};
}
async function waitForRequest(
  gateway: MockGatewayControls,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
  after = 0,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests(method))
        .slice(after)
        .some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}
async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}
const emptyUsage = {
  updatedAt: Date.now(),
  sessions: [],
  totals: null,
  aggregates: {
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    daily: [],
  },
};
const multiAgentRoster = ["Main", "Reviewer", "Writer"].map((name) => ({
  id: name.toLowerCase(),
  identity: { name },
  name,
}));
const roster = (
  agents: Array<{ id: string; name: string; identity?: { name: string } }> = multiAgentRoster,
  defaultId = "main",
) => ({
  defaultId,
  mainKey: "main",
  scope: "per-sender",
  agents,
});
const emptyStartup = {
  messages: [],
  metadata: { models: [] },
  sessionId: "session:agent:main:main",
  thinkingLevel: null,
};
const emptySessions = {
  count: 0,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions: [],
  ts: Date.now(),
};
const expectAgent = (picker: Locator, value: string) =>
  expect
    .poll(() => picker.evaluate((element) => (element as HTMLElement & { value: string }).value))
    .toBe(value);
const expectAgentName = (sidebar: Locator, name: string) =>
  expect
    .poll(async () => (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim())
    .toBe(name);
suite.define(() => {
  it("follows the visible catalog groups when selecting an agent with the keyboard", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["cron.list"],
        methodResponses: {
          "agents.list": roster([
            ...multiAgentRoster.slice(0, 1),
            { id: "alpha", name: "Needle Alpha" },
            { id: "charlie", name: "Needle Charlie" },
          ]),
          "cron.list": {
            jobs: [
              {
                id: "bravo",
                name: "Needle Bravo",
                enabled: true,
                updatedAtMs: 0,
                scheduleKind: "every",
                schedule: { kind: "every", everyMs: 60_000 },
                nextRunAt: null,
                nextRunAtMs: null,
                lastRunAt: null,
                lastRunAtMs: null,
                lastRunStatus: null,
                lastRunError: null,
              },
            ],
            snapshotRevision: "palette-group-order",
            total: 1,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          },
          "sessions.list": { ts: 1, path: "", count: 0, defaults: {}, sessions: [] },
          "sessions.usage": emptyUsage,
        },
      });
      await page.goto(`${suite.server.baseUrl}usage`);
      await gateway.waitForRequest("agents.list");
      await page.keyboard.press("ControlOrMeta+k");
      const input = page.locator(".cmd-palette__input");
      await input.fill("Needle");
      await page.getByRole("option", { name: "Needle Bravo", exact: true }).waitFor();
      const options = page.locator("openclaw-command-palette").getByRole("option");
      await expect
        .poll(async () =>
          (await options.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()),
        )
        .toEqual(["Needle Alpha alpha", "Needle Charlie charlie", "Needle Bravo"]);
      await input.press("ArrowDown");
      await expect.poll(() => options.nth(1).getAttribute("aria-selected")).toBe("true");
      await screenshot(page, "09-palette-keyboard-group-order.png");
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/charlie");
    });
  });
  it.each(["ordinary reload", "route before hello"])(
    "opens a named agent from the palette without changing the chat agent (%s)",
    async (ordering) => {
      await suite.withPage(pageOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ordering === "route before hello" ? ["connect"] : [],
          methodResponses: {
            "agents.list": roster(),
            "sessions.usage": emptyUsage,
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        if (ordering === "route before hello") {
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
        }
        await gateway.waitForRequest("agents.list");
        const sidebar = page.locator("openclaw-app-sidebar");
        await expectAgentName(sidebar, "Main");
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator(".cmd-palette__input").fill("Reviewer");
        const result = page.getByRole("option", { name: "Reviewer reviewer", exact: true });
        await result.waitFor();
        await screenshot(page, "07-palette-reviewer-result.png");
        await result.click();
        const selectedAgent = page.locator(".settings-sidebar openclaw-agent-select");
        await selectedAgent.waitFor();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/reviewer");
        await expectAgent(selectedAgent, "reviewer");
        await screenshot(page, "08-palette-selected-agent.png");
        await page.reload();
        if (ordering === "route before hello") {
          await gateway.waitForRequest("connect");
          await waitForControlUiRoute(page, {
            pathname: "/settings/agents/reviewer",
            routeId: "agents",
          });
          await gateway.resolveDeferred("connect");
        }
        await expectAgent(selectedAgent, "reviewer");
        await waitForRequest(
          gateway,
          "models.list",
          (params) => params.agentId === "reviewer" && params.view === "configured",
        );
        await screenshot(page, "10-reloaded-reviewer.png");
        await page.goBack();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
        await expectAgentName(sidebar, "Main");
      });
    },
  );
  it.each([false, true])(
    "keeps the canonical roster across delayed startup (refresh settled first: %s)",
    async (settled) => {
      await suite.withPage(pageOptions(settled), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          deferredMethods: ["chat.startup"],
          methodResponses: settled
            ? {
                "agents.list": roster(
                  [
                    { id: "research", name: "Research" },
                    { id: "writer", name: "Writer" },
                  ],
                  "research",
                ),
              }
            : {},
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("agents.list");
        if (!settled) {
          await gateway.deferNext("agents.list");
        }
        await gateway.emitGatewayEvent("config.changed", { path: "agents.entries" });
        await gateway.waitForRequest("agents.list", { after: 1 });
        const sidebar = page.locator("openclaw-app-sidebar");
        if (settled) {
          await expectAgentName(sidebar, "Research");
        }
        await gateway.resolveDeferred("chat.startup", emptyStartup);
        if (!settled) {
          await gateway.resolveDeferred(
            "agents.list",
            roster([{ id: "research", name: "Research" }], "research"),
          );
        }
        await expectAgentName(sidebar, "Research");
        if (!settled) {
          return;
        }
        await expect
          .poll(() =>
            page.locator("openclaw-chat-pane").evaluate((pane) => {
              const state = (pane as HTMLElement & { state?: ChatPageHost }).state;
              return {
                default: state?.agentsList?.defaultId,
                ids: state?.agentsList?.agents?.map((agent) => agent.id),
                selected: state?.agentsSelectedId,
              };
            }),
          )
          .toEqual({ default: "research", ids: ["research", "writer"], selected: "research" });
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        const agentMenu = sidebar.locator(".sidebar-agent-menu");
        await agentMenu.getByText("Research", { exact: true }).waitFor();
        await agentMenu.getByText("Writer", { exact: true }).waitFor();
        expect(await agentMenu.getByText("Stale Main", { exact: true }).count()).toBe(0);
        if (captureUiProof) {
          await writeFile(
            path.join(proofDir, "00-refreshed-roster-wins.png"),
            await takeControlUiViewportScreenshot(page, agentMenu.locator('[part="menu"]'), [
              agentMenu.getByText("Research", { exact: true }),
              agentMenu.getByText("Writer", { exact: true }),
            ]),
          );
        }
      });
    },
  );
  it("scopes pages from the chip and keeps Agents settings independent", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": roster(),
          "chat.startup": {
            ...emptyStartup,
            agentsList: roster(),
          },
          "sessions.list": emptySessions,
          "sessions.usage": emptyUsage,
        },
      });
      await page.goto(`${suite.server.baseUrl}usage`);
      await gateway.waitForRequest("agents.list");
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      const agentMenu = sidebar.locator(".sidebar-agent-menu");
      await expect
        .poll(async () => {
          const [card, menu] = await Promise.all([
            sidebar.locator(".sidebar-agent-card__main").boundingBox(),
            agentMenu.boundingBox(),
          ]);
          if (!card || !menu) {
            return null;
          }
          return {
            besideCard: menu.x >= card.x + card.width,
            anchoredToCard: menu.y <= card.y + card.height && menu.y + menu.height >= card.y,
            inViewport: menu.x >= 0 && menu.x + menu.width <= page.viewportSize()!.width,
          };
        })
        .toEqual({ besideCard: true, anchoredToCard: true, inViewport: true });
      await agentMenu.locator('[data-value="agent:writer"]').click();
      await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
      await expectAgentName(sidebar, "Writer");
      await openHomeFullPage(page, "writer");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/writer");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar.locator('.sidebar-identity-menu [data-value="command:usage"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
      await waitForRequest(gateway, "sessions.usage", (params) => params.agentId === "writer");
      const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
      await expectAgent(pageScope, "writer");
      await screenshot(page, "01-writer-usage.png");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator(".sidebar-agent-menu")
        .locator('[data-value="agent:writer"]')
        .getByRole("button", { name: "Writer settings", exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/writer");
      expect(new URL(page.url()).searchParams.get("agent")).toBeNull();
      await screenshot(page, "03-writer-settings.png");
    });
  });
  it("updates the compact session scope label and exposes All agents", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": roster(),
          "sessions.list": emptySessions,
        },
      });
      await page.goto(`${suite.server.baseUrl}sessions`);
      await gateway.waitForRequest("agents.list");
      const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
      await expectAgent(pageScope, "main");
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "Writer" })
        .click();
      await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
      await expectAgent(pageScope, "writer");
      await expect
        .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      await screenshot(page, "05-first-session-scope-switch.png");
      const sessionRequestsBeforeAll = (await gateway.getRequests("sessions.list")).length;
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "All agents" })
        .evaluate((item) => (item as HTMLElement).click());
      await waitForRequest(
        gateway,
        "sessions.list",
        (params) => !Object.hasOwn(params, "agentId"),
        sessionRequestsBeforeAll,
      );
      await expectAgent(pageScope, "");
      await expect
        .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
        .toBe("All agents");
      await screenshot(page, "06-all-agents-session-scope.png");
    });
  });
});
