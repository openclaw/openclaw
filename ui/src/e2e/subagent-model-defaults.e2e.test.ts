// Control UI E2E proves the subagent model is editable for all agents and for one agent.
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalogModel, configAuth } from "./model-catalog-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI subagent model defaults",
  startServerBeforeBrowser: true,
});
const context = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 1000 },
} as const;
const models = [
  catalogModel("fixture", "orchestrator", "Fixture Orchestrator"),
  catalogModel("fixture", "runner", "Fixture Runner"),
];
const written = (params: unknown) => {
  const raw = (params as { raw: unknown }).raw;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

suite.define(() => {
  it("sets the subagent model for all agents from Models", async () => {
    await suite.withPage(context, async ({ page }) => {
      const config = { agents: { defaults: { model: "fixture/orchestrator" } } };
      const saved = {
        agents: {
          defaults: { model: "fixture/orchestrator", subagents: { model: "fixture/runner" } },
        },
      };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        models,
        methodResponses: {
          "config.get": sourceConfigSnapshot(config, "subagent-defaults"),
          "config.patch": { ok: true, config: saved, hash: "subagent-defaults-saved" },
          "models.list": { models },
          "models.authStatus": { ts: 1, providers: [configAuth("fixture")] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      const defaults = page.locator(".model-providers__defaults");
      await defaults.locator("[data-models-more-settings]").click();
      await defaults.locator("#model-providers-utility-model").waitFor();

      const picker = defaults.locator(
        "openclaw-select-picker:has(#model-providers-subagent-model)",
      );
      const trigger = picker.locator(".picker-select__trigger");
      expect(await trigger.textContent()).toContain("Same as the parent session");
      await gateway.setMethodResponse(
        "config.get",
        sourceConfigSnapshot(saved, "subagent-defaults-saved"),
      );
      await selectPickerValue(picker, "fixture/runner");
      const patch = written((await gateway.waitForRequest("config.patch")).params);
      expect(patch.agents.defaults.subagents).toEqual({ model: "fixture/runner" });
      await expect.poll(() => trigger.textContent()).toContain("Fixture Runner");
    });
  });

  it("overrides the subagent model for one agent from its Overview", async () => {
    await suite.withPage(context, async ({ page }) => {
      const config = {
        agents: {
          defaults: { model: "fixture/orchestrator", subagents: { model: "fixture/runner" } },
          entries: { main: {} },
        },
      };
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "config.get",
          "models.list",
        ],
        models,
        methodResponses: {
          "agents.list": createAgentRoster({ main: "Main agent" }, "main", "agent"),
          "config.get": {
            ...sourceConfigSnapshot(config, "agent-subagent-model"),
            runtimeConfig: config,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      await gateway.waitForRequest("config.get");
      const agentsPage = page.locator("openclaw-agents-page");
      await agentsPage.locator("#agent-utility-model").waitFor();

      const picker = agentsPage.locator("openclaw-select-picker:has(#agent-subagent-model)");
      const trigger = picker.locator(".picker-select__trigger");
      expect(await trigger.textContent()).toContain("Inherit default (fixture/runner)");
      await selectPickerValue(picker, "fixture/orchestrator");
      const set = written((await gateway.waitForRequest("config.set")).params);
      expect(set.agents.entries.main).toEqual({ subagents: { model: "fixture/orchestrator" } });
      await expect.poll(() => trigger.textContent()).toContain("Fixture Orchestrator");
    });
  });
});
