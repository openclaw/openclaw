import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { configSnapshot, createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createConfigSuite("Control UI decision models and default agents");

function configResponse(config: Record<string, unknown>, hash: string) {
  return { ...configSnapshot(config, hash), sourceConfig: config };
}
suite.define(() => {
  it("persists and clears a global decision model without a chat model", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let config: unknown = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {} },
        },
      };
      let revision = 0;
      const snapshot = () => ({
        config,
        sourceConfig: config,
        hash: `decision-${revision}`,
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": agentRoster({ main: "Main" }, "main", "per-sender"),
          "models.list": {
            models: [],
            decisionModels: [
              { provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" },
            ],
          },
          "config.get": snapshot(),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const picker = page.locator("openclaw-select-picker:has(#model-providers-decision-model)");
      await expect.poll(() => pickerValue(picker)).toBe("");
      for (const value of ["typesafe/jev-latest", ""]) {
        const before = (await gateway.getRequests("config.patch")).length;
        await gateway.deferNext("config.patch");
        await selectPickerValue(picker, value);
        const patch = requestRaw(await gateway.waitForRequest("config.patch", { after: before }));
        expect(patch).toMatchObject({ agents: { defaults: { decisionModel: value || null } } });
        config = applyMergePatch(config, patch);
        expect(JSON.stringify(config)).not.toContain('"model":');
        revision++;
        await gateway.setMethodResponse("config.get", snapshot());
        await gateway.resolveDeferred("config.patch", {
          ok: true,
          config,
          hash: `decision-${revision}`,
        });
        await page.reload();
        await expect.poll(() => pickerValue(picker)).toBe(value);
      }
    });
  });

  it.each([true, false])(
    "uses Gateway ownership for Set Default state (selection required: %s)",
    async (selectionRequired) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const defaultId = selectionRequired ? "main" : "research";
        const config = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, research: {} },
            ...(!selectionRequired ? { defaults: { systemAgent: { agentId: "research" } } } : {}),
          },
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: defaultId,
          methodResponses: {
            "agents.list": {
              ...agentRoster(
                { main: "Main agent", research: "Research agent" },
                defaultId,
                "per-sender",
              ),
              ownership: "explicit",
              selectionRequired,
            },
            "config.get": configResponse(config, "roster-hash"),
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/agents`);
        await gateway.waitForRequest("agents.list");
        await page.locator(".agent-select__trigger").click();
        await page.getByRole("menuitemradio", { name: /Research agent/ }).waitFor();

        expect(await page.locator(".agent-select__option .agent-select__badge").count()).toBe(0);
        await page
          .getByRole("menuitemradio", {
            name: selectionRequired ? "Main agent" : "Research agent",
            exact: true,
          })
          .click();
        const defaultAction = page.getByRole("button", {
          name: selectionRequired ? "Set Default" : "Default",
          exact: true,
        });
        await defaultAction.waitFor();
        await expect.poll(() => defaultAction.isDisabled()).toBe(!selectionRequired);
      }),
  );
});
