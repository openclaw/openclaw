// Control UI tests cover LM Studio setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  candidate,
  configSnapshot,
  expectCount,
  expectText,
  fullScreenshot,
  makeDetection,
  returnToLocalModelSettings,
  runningStep,
  runningWizard,
  setupArtifacts,
  setupContext,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI LM Studio setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifacts = setupArtifacts("model-setup-lmstudio");
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
            "openclaw.setup.prepare.start": runningWizard("lmstudio-prepare-session"),
            "openclaw.setup.activate.start": runningWizard("activation-session"),
            "wizard.next": {
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
                { done: true, status: "done", modelActivation: { modelRef } },
              ],
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        const lmStudioRow = page.locator('[data-prepare-choice="lmstudio"]');
        await lmStudioRow.getByRole("button", { name: "Connect server" }).waitFor();
        await expectCount(lmStudioRow.locator('[data-provider-icon="lmstudio"]'), 1);

        await fullScreenshot(page, artifacts.dir, "lmstudio-offer-desktop.png");

        await lmStudioRow.getByRole("button", { name: "Connect server" }).click();
        const start = await gateway.waitForRequest("openclaw.setup.prepare.start");
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

        await fullScreenshot(page, artifacts.dir, "lmstudio-recovery-desktop.png");

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText("Retry this LM Studio connection now?").waitFor();
        await gateway.setMethodResponse("openclaw.setup.detect", {
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

        const activate = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:lmstudio",
          agentId: "main",
          modelRef,
        });

        if (artifacts.dir) {
          await fullScreenshot(page, artifacts.dir, "lmstudio-ready-desktop.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await fullScreenshot(page, artifacts.dir, "lmstudio-ready-mobile.png");
        }

        await returnToLocalModelSettings(page, gateway, {
          provider: "lmstudio",
          label: "LM Studio",
          icon: "lmstudio",
          model: "qwen3-8b-instruct",
          hash: "lmstudio-activated",
        });
        await fullScreenshot(page, artifacts.dir, "lmstudio-main-desktop.png");
      },
    );
  });
});
