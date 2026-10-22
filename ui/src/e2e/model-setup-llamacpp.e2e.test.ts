// Control UI tests cover llama.cpp setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  candidate,
  expectLocalActivation,
  expectCount,
  expectText,
  localPrepareOptions,
  installLocalSetupGateway,
  makeDetection,
  returnToLocalModelSettings,
  runningStep,
  setupContext,
  setupRpc as rpc,
} from "./model-setup-fixtures.test-support.ts";
import { openModelSetup } from "./model-setup.test-support.ts";

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
        const gateway = await installLocalSetupGateway(page, initialDetection, "llama-cpp", [
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
          runningStep("llama-cpp-embedding-ready", "progress", "EmbeddingGemma model verified", {
            executor: "gateway",
          }),
          { done: true, status: "done" },
          activated(modelRef),
        ]);

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
            candidate("provider-auto:llama-cpp", "llama.cpp", modelRef, {
              brandId: "llama-cpp",
              detail: "Qwen3.5 9B downloaded",
              recommended: true,
            }),
          ],
        });
        await page.getByRole("button", { name: "Continue" }).click();
        await expectLocalActivation(page, gateway, "llama-cpp", modelRef, "llamacpp");

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
