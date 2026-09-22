import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const suite = createControlUiE2eSuite({ name: "Control UI global model defaults recovery" });
suite.define(() => {
  it.each([false, true])(
    "shows authoritative defaults after rejected save, retry, and external change; switch agent=%s",
    async (switchAgent) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1050 } },
        async ({ page }) => {
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
              { provider: "openai", id: "gpt-4.1", name: "GPT-4.1", available: true },
              { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini", available: true },
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
              "config.get": {
                config,
                sourceConfig: config,
                hash: "qa-settings-original",
                valid: true,
                issues: [],
                raw: JSON.stringify(config),
              },
              "models.authStatus": {
                ts: 1,
                providers: [{ provider: "openai", profiles: [], apiKey: { source: "config" } }],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          await waitForControlUiRoute(page, { routeId: "model-providers" });
          const primary = page.locator(".model-providers__defaults .model-picker").first();
          const trigger = primary.locator(".picker-select__trigger");
          const modelLabel = trigger.locator(".picker-select__label");
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
          await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
          await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
          const savedConfig = {
            ...config,
            agents: { ...config.agents, defaults: { model: { primary: "openai/gpt-4.1-mini" } } },
          };
          await gateway.setMethodResponse("config.get", {
            config: savedConfig,
            sourceConfig: savedConfig,
            hash: "qa-retried",
            valid: true,
            issues: [],
            raw: JSON.stringify(savedConfig),
          });
          await gateway.setMethodResponse("config.patch", {
            ok: true,
            config: savedConfig,
            hash: "qa-retried",
          });
          await page.getByRole("button", { name: "Retry", exact: true }).click();
          await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(2);
          const patches = await gateway.getRequests("config.patch");
          const retryParams = requireRecord(patches[1]?.params);
          expect(typeof retryParams.raw).toBe("string");
          const retryPatch: unknown = JSON.parse(String(retryParams.raw));
          expect(retryPatch).toMatchObject({
            agents: { defaults: { model: "openai/gpt-4.1-mini" } },
          });
          await expect
            .poll(() => page.getByRole("button", { name: "Retry", exact: true }).count())
            .toBe(0);
          await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1 mini");
          const previousReads = (await gateway.getRequests("config.get")).length;
          await gateway.setMethodResponse("config.get", {
            config,
            sourceConfig: config,
            hash: "qa-external",
            valid: true,
            issues: [],
            raw: JSON.stringify(config),
          });
          await gateway.emitGatewayEvent("config.changed", {});
          await expect
            .poll(async () => (await gateway.getRequests("config.get")).length)
            .toBeGreaterThan(previousReads);
          await expect.poll(() => trigger.isEnabled()).toBe(true);
          await expect.poll(() => modelLabel.textContent()).toBe("GPT-4.1");
          await page.screenshot({
            path: path.join(suite.artifactDir, `external-change-switch-${switchAgent}.png`),
          });
        },
      );
    },
  );
});
