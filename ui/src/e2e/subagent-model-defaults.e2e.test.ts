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
  {
    ...catalogModel("fixture", "orchestrator", "Fixture Orchestrator"),
    reasoning: true,
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    supportsFastMode: true,
    serviceTiers: ["priority"],
  },
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
      expect(await trigger.textContent()).toContain("Not set");
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

  it.each([1280, 390])(
    "overrides the subagent model from agent Overview at %ipx",
    async (width) => {
      await suite.withPage({ ...context, viewport: { width, height: 1000 } }, async ({ page }) => {
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
        // The panel should offer the same top-level controls and disclosure as Models.
        const more = agentsPage.getByRole("button", { name: "More settings", exact: true });
        await expect.poll(() => more.count()).toBe(1);
        for (const title of ["Effort", "Speed"]) {
          expect(await agentsPage.getByText(title, { exact: true }).first().isVisible()).toBe(true);
        }
        if ((await more.getAttribute("aria-expanded")) === "true") {
          await more.click();
        }
        const subagentRow = agentsPage.getByText("Subagent model", { exact: true });
        await expect.poll(() => subagentRow.isVisible()).toBe(false);
        await more.click();
        await expect.poll(() => subagentRow.isVisible()).toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);

        const controls = agentsPage.locator(
          ".model-providers__defaults .model-picker .picker-select__trigger",
        );
        const positions = await controls.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              width: rect.width,
              fits: rect.left >= 0 && rect.right <= innerWidth,
            };
          }),
        );
        expect(positions).toHaveLength(6);
        for (const box of positions) {
          expect(box.fits).toBe(true);
          expect(Math.abs(box.width - positions[0]!.width)).toBeLessThan(1);
          expect(Math.abs(box.left - positions[0]!.left)).toBeLessThan(1);
        }
        const picker = agentsPage
          .locator(".settings-row")
          .filter({ has: page.getByText("Subagent model", { exact: true }) })
          .locator("openclaw-select-picker");
        const trigger = picker.locator(".picker-select__trigger");
        expect(await trigger.textContent()).toContain("Inherit default (fixture/runner)");
        await selectPickerValue(picker, "fixture/orchestrator");
        const set = written((await gateway.waitForRequest("config.set")).params);
        expect(set.agents.defaults).toEqual(config.agents.defaults);
        expect(set.agents.entries.main).toEqual({ subagents: { model: "fixture/orchestrator" } });
        await expect.poll(() => trigger.textContent()).toContain("Fixture Orchestrator");
      });
    },
  );
});
