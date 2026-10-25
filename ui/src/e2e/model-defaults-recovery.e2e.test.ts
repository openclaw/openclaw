import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  catalogModel,
  configAuth,
  providerPageOptions,
} from "./model-catalog-fixtures.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const suite = createControlUiE2eSuite({ name: "Control UI global model defaults recovery" });
suite.define(() => {
  it.each([false, true])(
    "shows authoritative defaults after rejected save, retry, and external change; switch agent=%s",
    async (switchAgent) => {
      await suite.withPage(providerPageOptions(1440, 1050), async ({ page }) => {
        const config = {
          agents: {
            defaults: { model: { primary: "openai/gpt-4.1" } },
            entries: { main: {}, research: {} },
          },
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          assistantAgentId: "main",
          assistantName: "QA Main",
          models: [
            catalogModel("openai", "gpt-4.1", "GPT-4.1"),
            catalogModel("openai", "gpt-4.1-mini", "GPT-4.1 mini"),
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "QA Main" },
                { id: "research", name: "QA Research" },
              ],
            },
            "config.get": sourceConfigSnapshot(config, "qa-settings-original"),
            "models.authStatus": {
              ts: 1,
              providers: [configAuth("openai")],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const primary = page.locator(".model-providers__defaults .model-picker").first();
        const trigger = primary.locator(".picker-select__trigger");
        const modelLabel = trigger.locator(".picker-select__label");
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
        await gateway.deferNext("config.patch");
        await trigger.click();
        await primary.getByRole("option", { name: /GPT-4.1 mini/ }).click();
        await gateway.waitForRequest("config.patch");
        const agentPicker = page.locator(".settings-sidebar openclaw-agent-select");
        if (switchAgent) {
          await agentPicker.locator(".agent-select__trigger").click();
          await agentPicker
            .getByRole("menuitemradio", { name: "QA Research", exact: true })
            .click();
          await expect
            .poll(() => agentPicker.locator(".agent-select__label").textContent())
            .toContain("QA Research");
          await gateway.waitForRequest("models.authStatus", { match: { agentId: "research" } });
        }
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "Synthetic rejected model save",
        });
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await retry.waitFor();
        await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
        const savedConfig = {
          ...config,
          agents: { ...config.agents, defaults: { model: { primary: "openai/gpt-4.1-mini" } } },
        };
        await gateway.setMethodResponse(
          "config.get",
          sourceConfigSnapshot(savedConfig, "qa-retried"),
        );
        await gateway.setMethodResponse("config.patch", {
          ok: true,
          config: savedConfig,
          hash: "qa-retried",
        });
        await retry.click();
        await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(2);
        const patches = await gateway.getRequests("config.patch");
        const retryParams = requireRecord(patches[1]?.params);
        expect(typeof retryParams.raw).toBe("string");
        const retryPatch: unknown = JSON.parse(String(retryParams.raw));
        expect(retryPatch).toMatchObject({
          agents: { defaults: { model: "openai/gpt-4.1-mini" } },
        });
        await expect.poll(() => retry.count()).toBe(0);
        await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1 mini");
        const previousReads = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse("config.get", sourceConfigSnapshot(config, "qa-external"));
        await gateway.emitGatewayEvent("config.changed", {});
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(previousReads);
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
      });
    },
  );
});
