// Control UI tests cover local-provider recovery against a mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";
import {
  activationFailure,
  button,
  candidate,
  configSnapshot,
  expectCount,
  expectRequestCounts,
  expectText,
  makeDetection,
  providerLogin,
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

suite.define(() => {
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
        const gateway = await installSetupGateway(page, {
          agentModel: modelRef,
          models: [
            {
              id: "qwen3-8b-instruct",
              name: "qwen3-8b-instruct",
              provider: "lmstudio",
              available: true,
            },
          ],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            rpc.detect,
            "models.probe",
            rpc.prepare,
            rpc.next,
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
              candidates: [candidate("provider-auto:lmstudio", "LM Studio", modelRef)],
              prepareOptions: [{ id: "lmstudio", label: "LM Studio" }],
              configuredModel: modelRef,
              setupComplete: true,
            }),
            // models.probe intentionally sanitizes raw connection errors.
            "models.probe": {
              provider: "lmstudio",
              status: "unknown",
              error: "The connection probe failed.",
              results: [],
            },
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
        await button(selectedModel, "Test connection: LM Studio").click();
        await selectedModel
          .locator(".model-providers__probe-summary")
          .getByText("Connection failed", { exact: true })
          .waitFor();
        await expectText(
          selectedModel.locator(".model-providers__probe"),
          "The connection probe failed.",
        );
        await button(selectedModel, "Test connection: LM Studio").waitFor();
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
