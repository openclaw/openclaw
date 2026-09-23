// Control UI tests cover LM Studio setup against a mocked Gateway.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI LM Studio setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("model-setup-lmstudio", artifactRoot)
    : undefined;
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
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const initialDetection = {
          candidates: [],
          manualProviders: [],
          prepareOptions,
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        };
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
            "config.get": {
              config: initialConfig,
              sourceConfig: initialConfig,
              hash: "before-local-activation",
              raw: JSON.stringify(initialConfig),
              valid: true,
              issues: [],
            },
            "openclaw.setup.detect": initialDetection,
            "openclaw.setup.prepare.start": {
              sessionId: "lmstudio-prepare-session",
              done: false,
              status: "running",
            },
            "openclaw.setup.activate.start": {
              sessionId: "activation-session",
              done: false,
              status: "running",
            },
            "wizard.next": {
              sequence: [
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "lmstudio-base-url",
                    type: "text",
                    message: "LM Studio base URL",
                    initialValue: "http://localhost:1234/v1",
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "lmstudio-api-key",
                    type: "text",
                    message: "LM Studio API key",
                    placeholder: "Leave blank if auth is disabled",
                    sensitive: true,
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "lmstudio-retry",
                    type: "note",
                    title: "LM Studio",
                    message: [
                      "LM Studio could not be reached at http://localhost:1234/v1.",
                      "Start LM Studio (or run lms server start), then continue to retry.",
                    ].join("\n"),
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "lmstudio-retry-confirm",
                    type: "confirm",
                    message: "Retry this LM Studio connection now?",
                    initialValue: true,
                  },
                },
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
        await expect
          .poll(() => lmStudioRow.locator('[data-provider-icon="lmstudio"]').count())
          .toBe(1);

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "lmstudio-offer-desktop.png"),
          });
        }

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

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "lmstudio-recovery-desktop.png"),
          });
        }

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText("Retry this LM Studio connection now?").waitFor();
        await gateway.setMethodResponse("openclaw.setup.detect", {
          ...initialDetection,
          candidates: [
            {
              kind: "provider-auto:lmstudio",
              brandId: "lmstudio",
              label: "LM Studio",
              detail: "qwen3-8b-instruct at http://localhost:1234/v1",
              modelRef,
              recommended: false,
              credentials: true,
            },
          ],
        });
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expect
          .poll(() => page.locator(".model-setup-success").textContent())
          .toContain(modelRef);
        await expect
          .poll(() => page.locator(".model-setup-success").textContent())
          .not.toContain("Verified in");
        await expect
          .poll(() => page.locator('.model-setup-success [data-provider-icon="lmstudio"]').count())
          .toBe(1);

        const activate = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:lmstudio",
          agentId: "main",
          modelRef,
        });

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "lmstudio-ready-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "lmstudio-ready-mobile.png"),
          });
        }

        // Activation publishes agent defaults and the configured catalog. Models
        // reads those owners on return, not the retired setup current-model panel.
        const config = {
          agents: {
            defaults: initialConfig.agents.defaults,
            entries: { main: { model: { primary: modelRef } } },
          },
        };
        await gateway.setMethodResponse("config.get", {
          config,
          sourceConfig: config,
          hash: "lmstudio-activated",
          raw: JSON.stringify(config),
          valid: true,
          issues: [],
        });
        await gateway.setMethodResponse("models.list", {
          models: [
            { id: "gpt-5", name: "GPT-5", provider: "openai", available: true },
            {
              id: "qwen3-8b-instruct",
              name: "qwen3-8b-instruct",
              provider: "lmstudio",
              available: true,
            },
          ],
        });
        await gateway.setMethodResponse("models.authStatus", {
          ts: 2,
          providerCapabilities: [],
          providers: [
            { provider: "lmstudio", displayName: "LM Studio", status: "static", profiles: [] },
          ],
        });
        await gateway.emitGatewayEvent("config.changed", {});
        await page.setViewportSize({ height: 900, width: 1280 });
        await page.getByRole("button", { name: "Return to Models" }).click();
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        const currentConnection = page.locator('[data-provider-id="lmstudio"]');
        await currentConnection.getByText("LM Studio", { exact: true }).waitFor();
        const defaultPicker = page
          .locator(".model-providers__defaults openclaw-select-picker")
          .first();
        await defaultPicker.locator(".picker-select__trigger").click();
        await defaultPicker
          .locator('[role="option"][data-value="lmstudio/qwen3-8b-instruct"]')
          .waitFor({ state: "visible" });
        await defaultPicker.locator(".picker-select__trigger").click();
        await expect
          .poll(() => currentConnection.locator('[data-provider-icon="lmstudio"]').count())
          .toBe(1);
        await expect
          .poll(() =>
            pickerValue(page.locator(".model-providers__defaults openclaw-select-picker").first()),
          )
          .toBe(globalModel);
        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "lmstudio-main-desktop.png"),
          });
        }
      },
    );
  });
});
