import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { sessionsUsageResponse } from "../test-helpers/sessions-usage-response.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { configSnapshot, createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createConfigSuite("Control UI decision models and default agents");

const decisionModels = [
  { provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" },
  { provider: "typesafe", id: "jev-preview", name: "Jev Preview", pluginId: "typesafe" },
];

function configResponse(config: Record<string, unknown>, hash: string) {
  return { ...configSnapshot(config, hash), sourceConfig: config };
}
suite.define(() => {
  it("saves global decisions without a chat model and preserves per-agent inheritance, disable, and override", () =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        let config: unknown = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, scout: {} },
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
            "agents.list": agentRoster({ main: "Main", scout: "Scout" }, "main", "per-sender"),
            "models.list": { models: [], decisionModels },
            "config.get": snapshot(),
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": sessionsUsageResponse(),
          },
        });
        const commitConfig = async (method: "config.patch" | "config.set") => {
          revision++;
          await gateway.setMethodResponse("config.get", snapshot());
          const response =
            method === "config.set" ? snapshot() : { config, hash: `decision-${revision}` };
          await gateway.resolveDeferred(method, { ...response, ok: true });
          await page.reload();
        };

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const global = page.locator("openclaw-select-picker:has(#model-providers-decision-model)");
        await expect.poll(() => pickerValue(global)).toBe("");
        await global.locator("button").first().click();
        await global.getByRole("option", { name: "Jev", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        for (const value of ["typesafe/jev-latest", "", "typesafe/jev-latest"]) {
          const before = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await selectPickerValue(global, value);
          const request = await gateway.waitForRequest("config.patch", { after: before });
          const patch = requestRaw(request);
          expect(patch).toMatchObject({ agents: { defaults: { decisionModel: value || null } } });
          config = applyMergePatch(config, patch);
          await commitConfig("config.patch");
          await expect.poll(() => pickerValue(global)).toBe(value);
        }
        expect(JSON.stringify(config)).not.toContain('"model":');

        await page.goto(`${suite.server.baseUrl}settings/agents/scout/overview`);
        const agent = page.locator("openclaw-select-picker:has(#agent-decision-model)");
        await expect.poll(() => pickerValue(agent)).toBe("__openclaw_inherit_decision__");
        expect(await agent.textContent()).toContain("Use global default · Jev");
        for (const [value, expected] of [
          ["", ""],
          ["typesafe/jev-preview", "typesafe/jev-preview"],
          ["__openclaw_inherit_decision__", undefined],
        ] as const) {
          await selectPickerValue(agent, value);
          const before = (await gateway.getRequests("config.set")).length;
          await gateway.deferNext("config.set");
          await page
            .locator(".settings-section:has(#agent-decision-model)")
            .getByRole("button", { name: "Save", exact: true })
            .click();
          const request = await gateway.waitForRequest("config.set", { after: before });
          config = requestRaw(request);
          expect(config).toMatchObject({
            agents: {
              defaults: { decisionModel: "typesafe/jev-latest" },
              entries: { main: {} },
            },
          });
          if (expected === undefined) {
            expect(config).not.toHaveProperty("agents.entries.scout.decisionModel");
          } else {
            expect(config).toHaveProperty("agents.entries.scout.decisionModel", expected);
          }
          await commitConfig("config.set");
          await expect.poll(() => pickerValue(agent)).toBe(value);
        }
        await gateway.setMethodResponse("models.list", {
          models: [{ id: "chat", provider: "fixture", name: "Chat" }],
          decisionModels,
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await expect.poll(() => pickerValue(global)).toBe("typesafe/jev-latest");
        await page.setViewportSize({ width: 520, height: 900 });
        await global.scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      },
    ));

  it("persists Set Default through config.set instead of only staging the form draft", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const makeConfig = (agentId: string) => ({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId } },
          entries: { main: {}, kimi: {} },
        },
      });
      const initialConfig = makeConfig("main");
      const savedConfig = makeConfig("kimi");
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": agentRoster({ main: "Main agent", kimi: "Kimi agent" }, "main", "agent"),
          "config.get": configResponse(initialConfig, "hash-1"),
          "config.set": configResponse(savedConfig, "hash-2"),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents`);
      expect(response?.status()).toBe(200);

      const agentSelect = page.locator("openclaw-agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect.getByRole("menuitemradio", { name: "Kimi agent", exact: true }).click();
      await page.getByRole("button", { name: "Set Default", exact: true }).click();

      // A draft-only update never emits config.set.
      const setRequest = await gateway.waitForRequest("config.set");
      const saved = JSON.parse(String(requireRecord(setRequest.params).raw));
      expect(saved).toEqual(savedConfig);
      expect(requireRecord(saved).agents).not.toHaveProperty("list");
    }));

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
