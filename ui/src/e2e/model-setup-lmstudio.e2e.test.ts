// Control UI tests cover LM Studio setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  candidate,
  configSnapshot,
  expectCount,
  expectText,
  localSetupFeatures,
  makeDetection,
  returnToLocalModelSettings,
  runningStep,
  runningWizard,
  setupContext,
  setupRpc as rpc,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI LM Studio setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const prepareOptions = [
  {
    id: "lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    hint: "Connect to a running LM Studio server and use an already loaded model",
    actionLabel: "Connect server",
    icon: "https://cdn.simpleicons.org/lmstudio",
    website: "https://lmstudio.ai/download",
  },
];

suite.define(() => {
  it("connects, retries, verifies, and keeps LM Studio visible in settings", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const initialDetection = makeDetection({ prepareOptions });
        const modelRef = "lmstudio/qwen3-8b-instruct";
        const globalModel = "openai/gpt-5";
        const initialConfig = { agents: { defaults: { model: globalModel } } };
        const gateway = await installSetupGateway(page, {
          agentModel: globalModel,
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          featureMethods: localSetupFeatures,
          methodResponses: {
            "config.get": configSnapshot(initialConfig, "before-local-activation"),
            [rpc.detect]: initialDetection,
            [rpc.prepare]: runningWizard("lmstudio-prepare-session"),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: {
              sequence: [
                runningStep("lmstudio-base-url", "text", "LM Studio base URL", {
                  initialValue: "http://localhost:1234/v1",
                }),
                runningStep("lmstudio-api-key", "text", "LM Studio API key", {
                  placeholder: "Leave blank if auth is disabled",
                  sensitive: true,
                }),
                runningStep(
                  "lmstudio-retry",
                  "note",
                  [
                    "LM Studio could not be reached at http://localhost:1234/v1.",
                    "Start LM Studio (or run lms server start), then continue to retry.",
                  ].join("\n"),
                  { title: "LM Studio" },
                ),
                runningStep(
                  "lmstudio-retry-confirm",
                  "confirm",
                  "Retry this LM Studio connection now?",
                  { initialValue: true },
                ),
                { done: true, status: "done" },
                activated(modelRef),
              ],
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        const lmStudioRow = page.locator('[data-prepare-choice="lmstudio"]');
        await lmStudioRow.getByRole("button", { name: "Connect server" }).waitFor();
        await expectCount(lmStudioRow.locator('[data-provider-icon="lmstudio"]'), 1);

        await lmStudioRow.getByRole("button", { name: "Connect server" }).click();
        const start = await gateway.waitForRequest(rpc.prepare);
        expect(start.params).toMatchObject({ authChoice: "lmstudio" });
        await expect
          .poll(() => page.getByLabel("LM Studio base URL").inputValue())
          .toBe("http://localhost:1234/v1");
        await page.getByRole("button", { name: "Submit" }).click();
        await page.getByLabel("LM Studio API key").fill("");
        await page.getByRole("button", { name: "Submit" }).click();
        await page
          .getByText("LM Studio could not be reached at http://localhost:1234/v1.")
          .waitFor();

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText("Retry this LM Studio connection now?").waitFor();
        await gateway.setMethodResponse(rpc.detect, {
          ...initialDetection,
          candidates: [
            candidate("provider-auto:lmstudio", "LM Studio", modelRef, {
              brandId: "lmstudio",
              detail: "qwen3-8b-instruct at http://localhost:1234/v1",
            }),
          ],
        });
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expectText(page.locator(".model-setup-success"), modelRef);
        await expectText(page.locator(".model-setup-success"), "Verified in", true);
        await expectCount(page.locator('.model-setup-success [data-provider-icon="lmstudio"]'), 1);

        const activate = await gateway.waitForRequest(rpc.activate);
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:lmstudio",
          agentId: "main",
          modelRef,
        });

        await page.setViewportSize({ height: 844, width: 390 });

        await returnToLocalModelSettings(page, gateway, {
          provider: "lmstudio",
          label: "LM Studio",
          icon: "lmstudio",
          model: "qwen3-8b-instruct",
          hash: "lmstudio-activated",
        });
      },
    );
  });
});
