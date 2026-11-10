import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Control UI agent page scope",
  startServerBeforeBrowser: true,
});
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1440 },
};
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
const roster = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: ["Main", "Reviewer"].map((name) => ({
    id: name.toLowerCase(),
    identity: { name },
    name,
  })),
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
  it.each(["ordinary reload", "route before hello"])(
    "opens a named agent from the palette without changing the chat agent (%s)",
    async (ordering) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          authMode: ordering === "route before hello" ? "token" : undefined,
          deferredMethods: ordering === "route before hello" ? ["connect"] : [],
          methodResponses: {
            "agents.list": roster,
            "sessions.usage": emptyUsage,
          },
        });
        await page.goto(
          `${suite.server.baseUrl}usage${ordering === "route before hello" ? "#token=test-token" : ""}`,
        );
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
        await result.click();
        const selectedAgent = page.locator(".settings-sidebar openclaw-agent-select");
        await selectedAgent.waitFor();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/reviewer");
        await expectAgent(selectedAgent, "reviewer");
        if (ordering === "route before hello") {
          // The held hello must restore a real warm boot, without a connect-timeout retry.
          await expect
            .poll(() =>
              page.evaluate(() =>
                Object.keys(localStorage).some((key) =>
                  key.startsWith("openclaw.control.bootRecord.v1:"),
                ),
              ),
            )
            .toBe(true);
        }
        await page.reload();
        if (ordering === "route before hello") {
          await gateway.waitForRequest("connect");
          await waitForControlUiRoute(page, {
            pathname: "/settings/agents/reviewer",
            routeId: "agents",
          });
          expect(await gateway.getRequests("connect")).toHaveLength(1);
          await gateway.resolveDeferred("connect");
        }
        await expectAgent(selectedAgent, "reviewer");
        await gateway.waitForRequest("models.list", {
          match: { agentId: "reviewer", view: "configured" },
        });
        await page.goBack();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
        await expectAgentName(sidebar, "Main");
      });
    },
  );
});
