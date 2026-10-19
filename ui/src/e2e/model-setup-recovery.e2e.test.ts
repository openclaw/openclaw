// Control UI tests cover local-provider recovery against a mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  button,
  candidate,
  configSnapshot,
  expectCount,
  expectRequestCounts,
  expectText,
  makeDetection,
  providerLogin,
  runningStep,
  runningWizard,
  setupContext,
  setupRpc as rpc,
  pollRequestCount,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI local-provider recovery mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("verifies the current model connection and retries saved replacement credentials", async () => {
    await suite.withPage(
      setupContext({ viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const config = { agents: { defaults: { model: "openai/gpt-5" } } };
        const gateway = await installSetupGateway(page, {
          agentModel: "openai/gpt-5",
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            rpc.detect,
            "models.probe",
            rpc.activate,
            rpc.auth,
            rpc.next,
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
            [rpc.detect]: makeDetection({
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
            [rpc.activate]: runningWizard(),
            [rpc.next]: activated("openai/gpt-5"),
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
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() =>
            page
              .locator(".shell-nav.nav-drawer")
              .evaluate((element) => element.getAttribute("aria-hidden") !== "true"),
          )
          .toBe(false);
        await page.setViewportSize({ height: 900, width: 1280 });
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
        const detectCountBeforeRefresh = (await gateway.getRequests(rpc.detect)).length;
        const verifyCountBeforeRefresh = (await gateway.getRequests("models.probe")).length;
        await button(currentProvider, "Test connection").click();
        await pollRequestCount(gateway, "models.probe").toBe(verifyCountBeforeRefresh + 1);
        expect((await gateway.getRequests(rpc.detect)).length).toBe(detectCountBeforeRefresh);
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
        const activation = await gateway.waitForRequest(rpc.activate);
        expect(activation.params).toEqual({
          kind: "saved-auth:openai:replacement",
          modelRef: "openai/gpt-5",
          agentId: "main",
          sessionId: expect.any(String),
        });
        await page.locator(".model-setup-success").waitFor();
        await expectRequestCounts(gateway, { [rpc.activate]: 1, [rpc.auth]: 0 });
      },
    );
  });

  it.each(["rejected", "uncertain"] as const)(
    "preserves first-run recovery after a terminal %s activation outcome",
    async (outcome) => {
      await suite.withPage(
        setupContext({ viewport: { height: 900, width: 1280 } }),
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [rpc.detect, rpc.auth, rpc.next],
            methodResponses: {
              [rpc.detect]: makeDetection({ authOptions: [providerLogin] }),
              [rpc.auth]: runningWizard(),
              [rpc.next]: {
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
          await expectRequestCounts(gateway, { [rpc.auth]: 1, [rpc.activate]: 0 });
          if (outcome === "uncertain") {
            const recovery = page.locator(".model-setup__recovery");
            await button(recovery, "Check again").click();
            await page.getByText("may still be running", { exact: false }).waitFor();
            expect(await gateway.getRequests(rpc.auth)).toHaveLength(1);
            expect(await page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(
              receipt,
            );
          } else {
            await signIn.click();
            await alert.waitFor();
            await alert.getByText("The model could not finish setup", { exact: true }).waitFor();
            expect(await gateway.getRequests(rpc.auth)).toHaveLength(2);
          }
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
            rpc.detect,
            "models.probe",
            rpc.prepare,
            rpc.next,
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
            [rpc.detect]: makeDetection({
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
            [rpc.prepare]: runningWizard("lmstudio-recovery-session"),
            [rpc.next]: runningStep("lmstudio-base-url", "text", "LM Studio base URL", {
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
        await expectRequestCounts(gateway, { [rpc.prepare]: 0, [rpc.activate]: 0 });

        await page.setViewportSize({ height: 844, width: 390 });

        const verify = await gateway.waitForRequest("models.probe");
        expect(verify.params).toEqual({ provider: "lmstudio", agentId: "main" });
        await openModelSetup(page);
        expect(await page.locator('[data-candidate-kind="provider-auto:lmstudio"]').count()).toBe(
          0,
        );
        expect(await page.locator('[data-prepare-choice="lmstudio"]').count()).toBe(0);
        await expectRequestCounts(gateway, { [rpc.prepare]: 0, [rpc.activate]: 0 });
      },
    );
  });
});
