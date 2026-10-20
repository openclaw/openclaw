import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Decision model settings",
  startServerBeforeBrowser: true,
});
const decisionModels = [
  { provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" },
  { provider: "typesafe", id: "jev-preview", name: "Jev Preview", pluginId: "typesafe" },
];
const capture = (page: Page, name: string) =>
  page.screenshot({ path: path.join(suite.artifactDir, name + ".png") });

suite.define(() => {
  it("saves global decisions without a chat model and preserves per-agent inheritance, disable, and override", async () => {
    await suite.withPage(
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
            "agents.list": {
              agents: [
                { id: "main", name: "Main" },
                { id: "scout", name: "Scout" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
            },
            "models.list": { models: [], decisionModels },
            "models.authStatus": { ts: 1, providers: [] },
            "config.get": snapshot(),
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        const saveSnapshot = async () => {
          revision++;
          await gateway.setMethodResponse("config.get", snapshot());
        };

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const global = page.locator("openclaw-select-picker:has(#model-providers-decision-model)");
        await expect.poll(() => pickerValue(global)).toBe("");
        await capture(page, "global-disabled");
        await global.locator("button").first().click();
        await global.getByRole("option", { name: "Jev", exact: true }).waitFor();
        await capture(page, "global-decision-options");
        await page.keyboard.press("Escape");
        for (const value of ["typesafe/jev-latest", "", "typesafe/jev-latest"]) {
          const before = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await selectPickerValue(global, value);
          const request = await gateway.waitForRequest("config.patch", { after: before });
          const patch = requestRaw(request);
          expect(patch).toMatchObject({ agents: { defaults: { decisionModel: value || null } } });
          config = applyMergePatch(config, patch);
          await saveSnapshot();
          await gateway.resolveDeferred("config.patch", {
            ok: true,
            config,
            hash: `decision-${revision}`,
          });
          await page.reload();
          await expect.poll(() => pickerValue(global)).toBe(value);
        }
        expect(JSON.stringify(config)).not.toContain('"model":');
        await capture(page, "global-jev-saved");

        await page.goto(`${suite.server.baseUrl}settings/agents/scout/overview`);
        const agent = page.locator("openclaw-select-picker:has(#agent-decision-model)");
        await expect.poll(() => pickerValue(agent)).toBe("__openclaw_inherit_decision__");
        expect(await agent.textContent()).toContain("Use global default · Jev");
        await capture(page, "agent-inherited");
        for (const [value, expected, proof] of [
          ["", "", "agent-disabled"],
          ["typesafe/jev-preview", "typesafe/jev-preview", "agent-override"],
          ["__openclaw_inherit_decision__", undefined, "agent-inheritance-restored"],
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
          await saveSnapshot();
          await gateway.resolveDeferred("config.set", { ...snapshot(), ok: true });
          await page.reload();
          await expect.poll(() => pickerValue(agent)).toBe(value);
          await capture(page, proof);
        }
        await gateway.setMethodResponse("models.list", {
          models: [{ id: "chat", provider: "fixture", name: "Chat" }],
          decisionModels,
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await expect.poll(() => pickerValue(global)).toBe("typesafe/jev-latest");
        await global.locator(".picker-select__trigger").click();
        expect(
          await page.locator('[role="option"][data-value="typesafe/jev-latest"]').count(),
        ).toBe(1);
        expect(await global.locator('[role="option"][data-value="fixture/chat"]').count()).toBe(0);
        await page.keyboard.press("Escape");
        await capture(page, "global-with-chat-catalog");
        await page.setViewportSize({ width: 520, height: 900 });
        await global.scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await capture(page, "global-narrow");
      },
    );
  });
});
