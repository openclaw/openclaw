// Control UI tests cover local-provider recovery against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  button,
  candidate,
  configSnapshot,
  expectCount,
  expectRequestCounts,
  expectText,
  fullScreenshot,
  makeDetection,
  runningStep,
  runningWizard,
  screenshot,
  setupArtifacts,
  setupContext,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI local-provider recovery mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifacts = setupArtifacts("model-setup-recovery");

suite.define(() => {
  it("verifies the current model connection and retries saved replacement credentials", async () => {
    await suite.withPage(
      setupContext({ viewport: { height: 900, width: 1280 } }, artifacts.dir),
      async ({ page }) => {
        const config = { agents: { defaults: { model: "openai/gpt-5" } } };
        const gateway = await installSetupGateway(page, {
          agentModel: "openai/gpt-5",
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "models.probe",
            "openclaw.setup.activate.start",
            "openclaw.setup.auth.start",
            "wizard.next",
          ],
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          methodResponses: {
            "config.get": configSnapshot(config, "configured-provider"),
            "models.authStatus": {
              ts: 1,
              providerCapabilities: [],
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "static",
                  profiles: [{ profileId: "openai:existing", type: "api_key", status: "static" }],
                },
              ],
            },
            "openclaw.setup.detect": makeDetection({
              candidates: [
                candidate("existing-model", "Current model", "openai/gpt-5", {
                  brandId: "openai",
                  detail: "openai/gpt-5 — already configured",
                }),
                candidate("provider-auto:openai", "OpenAI", "openai/gpt-5", {
                  brandId: "openai",
                  detail: "Already configured",
                }),
                candidate(
                  "saved-auth:openai:replacement",
                  "Saved OpenAI credentials",
                  "openai/gpt-5",
                  { brandId: "openai", detail: "Saved for retry after a failed setup test" },
                ),
                candidate("claude-cli", "Claude Code", "claude-cli/claude-opus-5", {
                  brandId: "claude",
                  detail: "logged in",
                }),
              ],
              configuredModel: "openai/gpt-5",
              setupComplete: true,
            }),
            "models.probe": {
              provider: "openai",
              status: "ok",
              latencyMs: 1234,
              results: [
                { label: "Configured credential · openai/gpt-5", status: "ok", latencyMs: 1234 },
              ],
            },
            "openclaw.setup.activate.start": runningWizard(),
            "wizard.next": {
              done: true,
              status: "done",
              modelActivation: { modelRef: "openai/gpt-5" },
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        await expectCount(page.locator('[data-candidate-kind="existing-model"]'), 0);
        await expectCount(page.locator('[data-candidate-kind="claude-cli"]'), 1);
        expect(await page.locator('[data-candidate-kind="provider-auto:openai"]').count()).toBe(0);
        const savedCredentials = page.locator(
          '[data-candidate-kind="saved-auth:openai:replacement"]',
        );
        await savedCredentials.getByText("Saved OpenAI credentials", { exact: true }).waitFor();
        if (artifacts.dir) {
          await writeFile(
            path.join(artifacts.dir, "configured-route-dedup-desktop.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator('[data-candidate-kind="claude-cli"]'),
              savedCredentials,
            ]),
          );
          await page.setViewportSize({ height: 844, width: 390 });
          await expect
            .poll(() =>
              page
                .locator(".shell-nav.nav-drawer")
                .evaluate((element) => element.getAttribute("aria-hidden") !== "true"),
            )
            .toBe(false);
          await writeFile(
            path.join(artifacts.dir, "configured-route-dedup-mobile.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator('[data-candidate-kind="claude-cli"]'),
              savedCredentials,
            ]),
          );
          await page.setViewportSize({ height: 900, width: 1280 });
        }
        await button(page.locator(".model-setup-discovery"), "Close").click();
        const currentProvider = page.locator('[data-provider-id="openai"]');
        await button(currentProvider, "Test connection").click();
        const verify = await gateway.waitForRequest("models.probe");
        expect(verify.params).toEqual({ provider: "openai", agentId: "main" });
        await currentProvider
          .locator(".model-providers__probe-target")
          .getByText("Connected · Request round-trip: 1234 ms", { exact: true })
          .waitFor();
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("Connected", { exact: true })
          .waitFor();
        const detectCountBeforeRefresh = (await gateway.getRequests("openclaw.setup.detect"))
          .length;
        const verifyCountBeforeRefresh = (await gateway.getRequests("models.probe")).length;
        await button(currentProvider, "Test connection").click();
        await expect
          .poll(async () => (await gateway.getRequests("models.probe")).length)
          .toBe(verifyCountBeforeRefresh + 1);
        expect((await gateway.getRequests("openclaw.setup.detect")).length).toBe(
          detectCountBeforeRefresh,
        );
        await button(currentProvider, "Test connection").waitFor();
        await currentProvider
          .locator(".model-providers__probe-target")
          .getByText("Connected · Request round-trip: 1234 ms", { exact: true })
          .waitFor();
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("Connected", { exact: true })
          .waitFor();
        await openModelSetup(page);
        await button(savedCredentials, "Test & use for this agent").click();
        const activation = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activation.params).toEqual({
          kind: "saved-auth:openai:replacement",
          modelRef: "openai/gpt-5",
          agentId: "main",
          sessionId: expect.any(String),
        });
        await page.locator(".model-setup-success").waitFor();
        await expectRequestCounts(gateway, {
          "openclaw.setup.activate.start": 1,
          "openclaw.setup.auth.start": 0,
        });
        if (artifacts.dir) {
          await writeFile(
            path.join(artifacts.dir, "saved-retry-request.json"),
            JSON.stringify(
              {
                activation,
                activations: await gateway.getRequests("openclaw.setup.activate.start"),
                signIns: await gateway.getRequests("openclaw.setup.auth.start"),
              },
              null,
              2,
            ),
          );
          await writeFile(
            path.join(artifacts.dir, "saved-retry-success-desktop.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".model-setup-success"),
            ]),
          );
        }
      },
    );
  });

  it.each(["rejected", "uncertain"] as const)(
    "preserves first-run recovery after a terminal %s activation outcome",
    async (outcome) => {
      await suite.withPage(
        setupContext({ viewport: { height: 900, width: 1280 } }, artifacts.dir),
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["openclaw.setup.detect", "openclaw.setup.auth.start", "wizard.next"],
            methodResponses: {
              "openclaw.setup.detect": makeDetection({
                authOptions: [
                  { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
                ],
              }),
              "openclaw.setup.auth.start": runningWizard(),
              "wizard.next": {
                done: true,
                status: "error",
                error: "The model could not finish setup",
                ...(outcome === "rejected"
                  ? {
                      activationRejection: {
                        disposition: "rejected-before-promotion",
                        status: "timeout",
                      },
                    }
                  : {}),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          const signIn = page.locator('[data-auth-choice="provider-login"] button');
          await signIn.waitFor();
          await screenshot(page, artifacts.dir, `${outcome}-before.png`, {
            animations: "disabled",
          });
          await signIn.click();
          const dialog = page.locator("openclaw-modal-dialog");
          const alert = dialog.getByRole("alert");
          await alert.waitFor();
          await alert.getByText("The model could not finish setup", { exact: true }).waitFor();
          expect(await dialog.locator("details").count()).toBe(0);
          await button(dialog, "Close").click();
          await expectCount(dialog, 0);
          await expect.poll(() => signIn.isDisabled()).toBe(outcome === "uncertain");
          const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
          const receipt = await page.evaluate((key) => localStorage.getItem(key), receiptKey);
          expect(receipt === null).toBe(outcome === "rejected");
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          await expectRequestCounts(gateway, {
            "openclaw.setup.auth.start": 1,
            "openclaw.setup.activate.start": 0,
          });
          if (outcome === "uncertain") {
            const recovery = page.locator(".model-setup__recovery");
            await button(recovery, "Check again").click();
            await page.getByText("may still be running", { exact: false }).waitFor();
            expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
            expect(await page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(
              receipt,
            );
          } else {
            await signIn.click();
            await alert.waitFor();
            await alert.getByText("The model could not finish setup", { exact: true }).waitFor();
            expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(2);
          }
          await screenshot(page, artifacts.dir, `${outcome}-after.png`, { animations: "disabled" });
        },
      );
    },
  );

  it("shows a failed configured LM Studio connection without implicit preparation", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const modelRef = "lmstudio/qwen3-8b-instruct";
        const config = {
          agents: { defaults: { model: modelRef } },
          // LM Studio persists this non-secret placeholder for local, unauthenticated access.
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                apiKey: "lmstudio-local",
                models: [{ id: "qwen3-8b-instruct", name: "qwen3-8b-instruct" }],
              },
            },
          },
        };
        const gateway = await installSetupGateway(page, {
          agentModel: modelRef,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "models.probe",
            "openclaw.setup.prepare.start",
            "wizard.next",
          ],
          models: [
            {
              id: "qwen3-8b-instruct",
              name: "qwen3-8b-instruct",
              provider: "lmstudio",
              available: true,
            },
          ],
          methodResponses: {
            "config.get": configSnapshot(config, "configured-provider"),
            "models.authStatus": {
              ts: 1,
              providerCapabilities: [],
              providers: [
                { provider: "lmstudio", displayName: "LM Studio", status: "static", profiles: [] },
              ],
            },
            "openclaw.setup.detect": makeDetection({
              candidates: [
                candidate("provider-auto:lmstudio", "LM Studio", modelRef, {
                  brandId: "lmstudio",
                  detail: "qwen3-8b-instruct at http://localhost:1234/v1",
                }),
              ],
              prepareOptions: [
                {
                  id: "lmstudio",
                  brandId: "lmstudio",
                  label: "LM Studio",
                  hint: "Connect to a running LM Studio server and use an already loaded model",
                  actionLabel: "Connect server",
                },
              ],
              configuredModel: modelRef,
              setupComplete: true,
            }),
            // models.probe intentionally sanitizes raw connection errors.
            "models.probe": {
              provider: "lmstudio",
              status: "unknown",
              error: "The connection probe failed.",
              results: [
                {
                  label: "Configured credential · lmstudio/qwen3-8b-instruct",
                  status: "unknown",
                  error: "The connection probe failed.",
                },
              ],
            },
            "openclaw.setup.prepare.start": runningWizard("lmstudio-recovery-session"),
            "wizard.next": runningStep("lmstudio-base-url", "text", "LM Studio base URL", {
              initialValue: "http://localhost:1234/v1",
            }),
          },
        });

        const response = await page.goto(suite.server.baseUrl + "settings/model-providers");
        expect(response?.status()).toBe(200);
        const selectedModel = page.locator('[data-provider-id="lmstudio"]');
        await selectedModel.getByText("LM Studio", { exact: true }).waitFor();
        await expectText(
          page.locator(".model-providers__defaults openclaw-select-picker").first(),
          "qwen3-8b-instruct",
        );
        await button(selectedModel, "Test connection").click();
        await selectedModel
          .locator(".model-providers__probe-summary")
          .getByText("Connection failed", { exact: true })
          .waitFor();
        await expectText(
          selectedModel.locator(".model-providers__probe"),
          "The connection probe failed.",
        );
        await button(selectedModel, "Test connection").waitFor();
        await expectRequestCounts(gateway, {
          "openclaw.setup.prepare.start": 0,
          "openclaw.setup.activate.start": 0,
        });

        if (artifacts.dir) {
          await fullScreenshot(page, artifacts.dir, "local-provider-failure-desktop.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await fullScreenshot(page, artifacts.dir, "local-provider-failure-mobile.png");
        }

        const verify = await gateway.waitForRequest("models.probe");
        expect(verify.params).toEqual({ provider: "lmstudio", agentId: "main" });
        await openModelSetup(page);
        expect(await page.locator('[data-candidate-kind="provider-auto:lmstudio"]').count()).toBe(
          0,
        );
        expect(await page.locator('[data-prepare-choice="lmstudio"]').count()).toBe(0);
        await expectRequestCounts(gateway, {
          "openclaw.setup.prepare.start": 0,
          "openclaw.setup.activate.start": 0,
        });
      },
    );
  });
});
