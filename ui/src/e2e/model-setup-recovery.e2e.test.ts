// Control UI tests cover local-provider recovery against a mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";
import {
  activated,
  activationFailure,
  button,
  candidate,
  configSnapshot,
  expectCount,
  expectRequestCounts,
  expectText,
  makeDetection,
  pollRequestCount,
  providerLogin,
  runningStep,
  runningWizard,
  setupContext,
  setupPages,
  setupRpc as rpc,
  waitText,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI local-provider recovery mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const withPage = setupPages(suite, () => setupContext({ viewport: { height: 900, width: 1280 } }));

function configuredProvider(
  provider: string,
  displayName: string,
  id: string,
  options: { name?: string; config?: object; profiles?: Record<string, string>[] } = {},
) {
  const modelRef = `${provider}/${id}`;
  return {
    agentModel: modelRef,
    models: [{ id, name: options.name ?? id, provider, available: true }],
    methodResponses: {
      "config.get": configSnapshot(
        options.config ?? { agents: { defaults: { model: modelRef } } },
        "configured-provider",
      ),
      "models.authStatus": {
        ts: 1,
        providerCapabilities: [],
        providers: [{ provider, displayName, status: "static", profiles: options.profiles ?? [] }],
      },
    },
  };
}

suite.define(() => {
  it("verifies the current model connection and retries saved replacement credentials", async () => {
    await withPage(async ({ page }) => {
      const provider = configuredProvider("openai", "OpenAI", "gpt-5", {
        name: "GPT-5",
        profiles: [{ profileId: "openai:existing", type: "api_key", status: "static" }],
      });
      const gateway = await installSetupGateway(page, {
        ...provider,
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          rpc.detect,
          "models.probe",
          rpc.activate,
          rpc.auth,
          rpc.next,
        ],
        methodResponses: {
          ...provider.methodResponses,
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
      await waitText(savedCredentials, "Saved OpenAI credentials");
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
      const currentProvider = await expandProvider(page, "openai");
      for (let attempt = 0; attempt < 2; attempt++) {
        const detections = (await gateway.getRequests(rpc.detect)).length;
        const probes = (await gateway.getRequests("models.probe")).length;
        await button(currentProvider, "Test connection").click();
        const verify = await gateway.waitForRequest("models.probe", { after: probes });
        expect(verify.params).toEqual({ provider: "openai", agentId: "main" });
        if (attempt === 1) {
          await pollRequestCount(gateway, "models.probe").toBe(probes + 1);
          expect((await gateway.getRequests(rpc.detect)).length).toBe(detections);
        }
        await button(currentProvider, "Test connection").waitFor();
        await waitText(
          currentProvider.locator(".model-providers__probe-target"),
          "Connected · Request round-trip: 1234 ms",
        );
        await waitText(currentProvider.locator(".model-providers__probe-summary"), "Connected");
      }
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
    });
  });

  it.each(["rejected", "uncertain"] as const)(
    "preserves first-run recovery after a terminal %s activation outcome",
    async (outcome) => {
      await withPage(async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [rpc.detect, rpc.auth, rpc.next],
          methodResponses: {
            [rpc.detect]: makeDetection({ authOptions: [providerLogin] }),
            [rpc.auth]: runningWizard(),
            [rpc.next]: activationFailure(
              "The model could not finish setup",
              outcome === "rejected" ? "timeout" : undefined,
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        const signIn = page.locator('[data-auth-choice="provider-login"] button');
        await signIn.waitFor();

        await signIn.click();
        const dialog = page.locator("openclaw-modal-dialog");
        const alert = dialog.getByRole("alert");
        await alert.waitFor();
        await waitText(alert, "The model could not finish setup");
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
          await waitText(page, "may still be running", false);
          expect(await gateway.getRequests(rpc.auth)).toHaveLength(1);
          expect(await page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(receipt);
        } else {
          await signIn.click();
          await alert.waitFor();
          await waitText(alert, "The model could not finish setup");
          expect(await gateway.getRequests(rpc.auth)).toHaveLength(2);
        }
      });
    },
  );

  it("shows a failed configured LM Studio connection without implicit preparation", async () => {
    await withPage(
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
        const provider = configuredProvider("lmstudio", "LM Studio", "qwen3-8b-instruct", {
          config,
        });
        const gateway = await installSetupGateway(page, {
          ...provider,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            rpc.detect,
            "models.probe",
            rpc.prepare,
            rpc.next,
          ],
          methodResponses: {
            ...provider.methodResponses,
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
        const selectedModel = await expandProvider(page, "lmstudio");
        await waitText(selectedModel, "LM Studio");
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
      { colorScheme: "dark", viewport: { height: 900, width: 1280 } },
    );
  });
});
