import { expect, it } from "vitest";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session Observer model catalog recovery",
  startServerBeforeBrowser: true,
});

const model = (id: string, name: string, provider = "openai") => ({
  available: true,
  id,
  name,
  provider,
});

suite.define(() => {
  it.each([
    "initial catalog failure",
    // Generic config changes do not invalidate model catalog receipts.
    "chat.metadata.changed",
    "reconnect",
  ] as const)("refreshes the catalog after %s", async (trigger) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        colorScheme: "dark",
      },
      async ({ page }) => {
        await page.clock.install();
        const initiallyUnavailable = trigger === "initial catalog failure";
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          ui: { prefs: { themeMode: "dark" } },
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.patch", "models.list", "system.info"],
          methodResponses: {
            "config.get": {
              config,
              hash: "session-observer-catalog-recovery",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
            "config.patch": { ok: true },
            "models.list": initiallyUnavailable
              ? {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Model catalog temporarily unavailable",
                  },
                }
              : { models: [model("old-model", "Old model")] },
          },
        });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-sidebar`,
        );
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        const section = page.locator("#settings-appearance-sidebar");
        const warning = section.getByText("Explicit model catalog unavailable", { exact: true });
        await section.getByRole("heading", { name: "Session observer" }).waitFor();
        const picker = section.locator("openclaw-select-picker.model-picker__select");
        await picker.waitFor();
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(1);
        await picker.locator(".picker-select__trigger").click();
        if (initiallyUnavailable) {
          await warning.waitFor();
        } else {
          await picker
            .locator('[role="option"]')
            .filter({ hasText: "Old model" })
            .waitFor({ state: "attached" });
        }
        await pauseVirtualClock(page);
        const initialSystemInfoRequestCount = (await gateway.getRequests("system.info")).length;
        expect(initialSystemInfoRequestCount).toBeGreaterThan(0);

        const initialRequest = (await gateway.getRequests("models.list"))[0];
        expect(initialRequest?.params).toEqual({
          agentId: "main",
          preparedOnly: true,
          view: "configured",
        });
        expect(await warning.isVisible().catch(() => false)).toBe(initiallyUnavailable);
        const optionLabels = async () =>
          (await picker.locator('[role="option"] .picker-select__label').allTextContents()).map(
            (text) => text.trim(),
          );
        expect(await optionLabels()).toEqual([
          "Auto (provider default)",
          "Disabled",
          ...(initiallyUnavailable ? [] : ["Old model"]),
        ]);
        await page.keyboard.press("Escape");

        const recoveredModels = [
          model("gpt-recovered", "GPT Recovered"),
          model("claude-recovered", "Claude Recovered", "anthropic"),
        ];
        await gateway.setMethodResponse("models.list", { models: recoveredModels });
        if (trigger === "reconnect") {
          // Device signing can finish after a clock advance; let its mock replies run.
          await page.clock.resume();
          await gateway.closeLatest(1006, "synthetic transient disconnect");
        } else {
          if (!initiallyUnavailable) {
            await gateway.emitGatewayEvent(trigger, { agentId: "main" });
          }
          await page.clock.runFor(10_000);
        }
        await expect
          .poll(async () => (await gateway.getRequests("system.info")).length)
          .toBe(initialSystemInfoRequestCount + 1);
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        expect((await gateway.getRequests("models.list"))[1]?.params).toEqual(
          initialRequest?.params,
        );
        expect(await warning.isVisible().catch(() => false)).toBe(false);
        await picker.locator(".picker-select__trigger").click();
        await expect
          .poll(() => picker.locator(".picker-select__trigger").getAttribute("aria-expanded"))
          .toBe("true");
        expect(await optionLabels()).toEqual([
          "Auto (provider default)",
          "Disabled",
          "Claude Recovered",
          "GPT Recovered",
        ]);

        await picker.locator('[role="option"][data-value="openai/gpt-recovered"]').click();
        const patchRequest = await gateway.waitForRequest("config.patch");
        expect(JSON.parse(String((patchRequest.params as { raw?: unknown }).raw))).toEqual({
          agents: { defaults: { utilityModel: "openai/gpt-recovered" } },
        });
      },
    );
  });
});
