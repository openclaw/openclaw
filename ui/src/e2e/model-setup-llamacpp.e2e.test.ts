// Control UI tests cover llama.cpp setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  configSnapshot,
  expectCount,
  expectText,
  fullScreenshot,
  makeDetection,
  returnToLocalModelSettings,
  runningStep,
  runningWizard,
  screenshot,
  setupArtifacts,
  setupContext,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI llama.cpp setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifacts = setupArtifacts("model-setup-llamacpp");
const prepareOptions = [
  {
    id: "ollama",
    brandId: "ollama",
    label: "Ollama",
    hint: "Connect to an Ollama server and select a cloud or local model",
    actionLabel: "Choose connection",
  },
  {
    id: "llama-cpp",
    brandId: "llama-cpp",
    label: "llama.cpp",
    hint: "Choose a Qwen, Gemma, or Muse model for this Gateway’s hardware and install llama.cpp",
    actionLabel: "Set up model",
  },
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
  it("downloads, verifies, and keeps llama.cpp visible in settings", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 900, width: 1280 } }, artifacts.dir),
      async ({ page }) => {
        const initialDetection = makeDetection({ prepareOptions });
        const modelRef = "llama-cpp/qwen3.5-9b-q4_k_m";
        const globalModel = "openai/gpt-5";
        const initialConfig = { agents: { defaults: { model: globalModel } } };
        const gateway = await installSetupGateway(page, {
          agentModel: globalModel,
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "openclaw.setup.prepare.start",
            "wizard.next",
          ],
          methodResponses: {
            "config.get": configSnapshot(initialConfig, "before-local-activation"),
            "openclaw.setup.detect": initialDetection,
            "openclaw.setup.prepare.start": runningWizard("llama-cpp-prepare-session"),
            "openclaw.setup.activate.start": runningWizard("activation-session"),
            "wizard.next": {
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
                { done: true, status: "done", modelActivation: { modelRef } },
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

        await fullScreenshot(page, artifacts.dir, "llama-cpp-offer-desktop.png");

        await llamaCppRow.getByRole("button", { name: "Set up model" }).click();
        const start = await gateway.waitForRequest("openclaw.setup.prepare.start");
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

        await screenshot(page, artifacts.dir, "llama-cpp-confirm-desktop.png", { fullPage: true });

        await gateway.setMethodResponse("openclaw.setup.detect", {
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

        const activate = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:llama-cpp",
          agentId: "main",
          modelRef,
        });

        if (artifacts.dir) {
          await fullScreenshot(page, artifacts.dir, "llama-cpp-ready-desktop.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await fullScreenshot(page, artifacts.dir, "llama-cpp-ready-mobile.png");
        }

        await returnToLocalModelSettings(page, gateway, {
          provider: "llama-cpp",
          label: "llama.cpp",
          icon: "llamacpp",
          model: "qwen3.5-9b-q4_k_m",
          hash: "llamacpp-activated",
        });
        await fullScreenshot(page, artifacts.dir, "llama-cpp-main-desktop.png");
      },
    );
  });
});
