import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  catalogModel,
  configAuth,
  providerPageOptions,
} from "./model-catalog-fixtures.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI global model defaults recovery" });
suite.define(() => {
  it("shows authoritative defaults after an agent switch, rejected save, retry, and external change", async () => {
    await suite.withPage(providerPageOptions(1440, 1050), async ({ page }) => {
      const config = (primary = "openai/gpt-4.1") => ({
        agents: {
          defaults: { model: { primary } },
          entries: { main: {}, research: {} },
        },
      });
      const gateway = await installMockGateway(page, {
        models: [
          catalogModel("openai", "gpt-4.1", "GPT-4.1"),
          catalogModel("openai", "gpt-4.1-mini", "GPT-4.1 mini"),
        ],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: ["main", "research"].map((id) => ({ id, name: id })),
          },
          "config.get": configSnapshot(config(), "qa-settings-original"),
          "models.authStatus": {
            ts: 1,
            providers: [configAuth("openai")],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
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
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "research", exact: true }).click();
      await expect
        .poll(() => agentPicker.locator(".agent-select__label").textContent())
        .toContain("research");
      await gateway.waitForRequest("models.authStatus", { match: { agentId: "research" } });
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Synthetic rejected model save",
      });
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await retry.waitFor();
      await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
      const savedConfig = config("openai/gpt-4.1-mini");
      await gateway.setMethodResponse("config.get", configSnapshot(savedConfig, "qa-retried"));
      await gateway.setMethodResponse("config.patch", {
        ok: true,
        config: savedConfig,
        hash: "qa-retried",
      });
      await retry.click();
      await expect.poll(() => retry.count()).toBe(0);
      await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1 mini");
      await gateway.setMethodResponse("config.get", configSnapshot(config(), "qa-external"));
      await gateway.emitGatewayEvent("config.changed", {});
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
    });
  });
});
