// Control UI tests cover llama.cpp setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  configSnapshot,
  expectCount,
  expectText,
  localPrepareOptions,
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
  name: "Control UI llama.cpp setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const prepareOptions = localPrepareOptions(
  "Choose a Qwen, Gemma, or Muse model for this Gateway’s hardware and install llama.cpp",
);

suite.define(() => {
  it("downloads, verifies, and keeps llama.cpp visible in settings", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const initialDetection = makeDetection({ prepareOptions });
        const modelRef = "llama-cpp/qwen3.5-9b-q4_k_m";
        const globalModel = "openai/gpt-5";
        const initialConfig = { agents: { defaults: { model: globalModel } } };
        const gateway = await installSetupGateway(page, {
          agentModel: globalModel,
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          featureMethods: localSetupFeatures,
          methodResponses: {
            "config.get": configSnapshot(initialConfig, "before-local-activation"),
            [rpc.detect]: initialDetection,
            [rpc.prepare]: runningWizard("llama-cpp-prepare-session"),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: {
              sequence: [
                runningStep(
                  "llama-cpp-consent",
                  "confirm",
                  "Runs on Gateway host gateway-host (darwin/arm64), using Apple Metal.\n16 GiB RAM; 100 GiB free disk.\nQwen3.5 9B (Q4_K_M) fits the 12 GiB Metal unified memory budget with a 64K context. Runtime verification checks the actual model before activation.\nOpenClaw will check a real tool call before making this your default model.\n\nDownload Qwen3.5 9B (Q4_K_M) (5.7 GB), the local embedding model (about 0.3 GB), and the verified METAL runtime, then use this model?",
                  { initialValue: false },
                ),
                runningStep("llama-server-verified", "progress", "Verified llama-server b10534", {
                  executor: "gateway",
                }),
                runningStep(
                  "llama-cpp-download-20",
                  "progress",
                  "Downloading Qwen3.5 9B… 20% (1.1/5.7 GB, 38 MB/s)",
                  { executor: "gateway" },
                ),
                runningStep(
                  "llama-cpp-embedding-ready",
                  "progress",
                  "EmbeddingGemma model verified",
                  { executor: "gateway" },
                ),
                { done: true, status: "done" },
                activated(modelRef),
              ],
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        const llamaCppRow = page.locator('[data-prepare-choice="llama-cpp"]');
        await llamaCppRow.getByRole("button", { name: "Set up model" }).waitFor();
        await expectCount(llamaCppRow.locator('[data-provider-icon="llamacpp"]'), 1);
        await expectText(llamaCppRow, "Qwen3.5", true);
        await expectText(llamaCppRow, "GB", true);
        await expectText(llamaCppRow, "RAM", true);

        await llamaCppRow.getByRole("button", { name: "Set up model" }).click();
        const start = await gateway.waitForRequest(rpc.prepare);
        expect(start.params).toMatchObject({ authChoice: "llama-cpp" });
        await page.getByRole("heading", { name: "Set up a local model" }).waitFor();
        await page.getByText("Runs on Gateway host gateway-host", { exact: false }).waitFor();
        await expectText(
          page.getByText("Runs on Gateway host gateway-host", { exact: false }),
          "using Apple Metal",
        );
        await page.locator("openclaw-modal-dialog > dialog").evaluate(async (dialog) => {
          await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
        });
        await expect
          .poll(() =>
            page.locator("openclaw-modal-dialog > dialog[open]").evaluate((dialog) => ({
              opening: dialog.getAttribute("data-phase") === "opening",
              opacity: getComputedStyle(dialog).opacity,
              visibility: getComputedStyle(dialog).visibility,
            })),
          )
          .toEqual({ opening: false, opacity: "1", visibility: "visible" });

        await gateway.setMethodResponse(rpc.detect, {
          ...initialDetection,
          candidates: [
            {
              kind: "provider-auto:llama-cpp",
              brandId: "llama-cpp",
              label: "llama.cpp",
              detail: "Qwen3.5 9B downloaded",
              modelRef,
              recommended: true,
              credentials: true,
            },
          ],
        });
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expectText(page.locator(".model-setup-success"), modelRef);
        await expectText(page.locator(".model-setup-success"), "Verified in", true);
        await expectCount(page.locator('.model-setup-success [data-provider-icon="llamacpp"]'), 1);

        const activate = await gateway.waitForRequest(rpc.activate);
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:llama-cpp",
          agentId: "main",
          modelRef,
        });

        await page.setViewportSize({ height: 844, width: 390 });

        await returnToLocalModelSettings(page, gateway, {
          provider: "llama-cpp",
          label: "llama.cpp",
          icon: "llamacpp",
          model: "qwen3.5-9b-q4_k_m",
          hash: "llamacpp-activated",
        });
      },
    );
  });
});
