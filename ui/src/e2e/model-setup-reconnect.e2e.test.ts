// Browser proof that model setup reloads after a same-client Gateway reconnect.
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { ConnectParamsSchema } from "../../../packages/gateway-protocol/src/schema.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  activationFailure,
  button,
  candidate,
  expectCount,
  expectRequestCounts,
  makeDetection,
  providerLogin,
  runningStep,
  runningWizard,
  setupContext,
  setupRpc as rpc,
  wizardNotFound,
  pollRequestCount,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model setup same-client reconnect",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const validateConnect = Compile(ConnectParamsSchema);
function connectParams(value: unknown) {
  if (!validateConnect.Check(value)) {
    throw new Error("Invalid connect request");
  }
  return value;
}

const onboardingWelcome = {
  sessionId: "e2e-first-run",
  reply: "Your model is ready. Let's finish setting up OpenClaw.",
  action: "none",
};

const detection = (modelRef: string) =>
  makeDetection({ configuredModel: modelRef, setupComplete: true });

suite.define(() => {
  it("offers the saved model after a restart loses the provider wizard", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const modelRef = "fixture/saved-model";
      const initialDetection = makeDetection({
        authOptions: [
          { id: "custom-api-key", label: "Local endpoint", kind: "custom", featured: true },
        ],
      });
      const gateway = await installMockGateway(page, {
        featureMethods: [
          rpc.detect,
          rpc.auth,
          rpc.verify,
          rpc.next,
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        methodResponses: {
          [rpc.detect]: initialDetection,
          [rpc.auth]: runningWizard(),
          [rpc.next]: runningStep("endpoint", "text", "API Base URL"),
          [rpc.verify]: { ok: true, modelRef },
          "openclaw.chat.history": { turns: [] },
          "openclaw.chat": onboardingWelcome,
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      await page.locator('[data-auth-choice="custom-api-key"] button').click();
      await page.getByLabel("API Base URL").waitFor();
      await gateway.setMethodResponse(rpc.detect, {
        ...initialDetection,
        configuredModel: modelRef,
        setupComplete: true,
      });
      await gateway.setMethodResponse(rpc.next, wizardNotFound);
      await gateway.closeLatest(1012, "Gateway restarted during model setup");
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByRole("alert").waitFor();
      await button(dialog, "Close").click();
      await page.getByText("saved-model", { exact: true }).waitFor();
      expect(await gateway.getRequests(rpc.verify)).toHaveLength(0);
      await button(page, "Verify & use selected model").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
      await expectRequestCounts(gateway, { [rpc.auth]: 1, [rpc.activate]: 0, [rpc.verify]: 1 });
    });
  });

  it.each(["reconnect", "reopen"])(
    "retains manual first-run activation through restart during config refresh (%s)",
    async (restart) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
        const modelRef = "openai/gpt-5.6-luna";
        const pendingVerification = {
          ok: false,
          status: "unavailable",
          error: "Gateway settings are saved but not active yet. Retry after the restart.",
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            rpc.detect,
            rpc.activate,
            rpc.next,
            rpc.verify,
            "openclaw.chat",
            "openclaw.chat.history",
          ],
          methodResponses: {
            "openclaw.chat.history": { turns: [] },
            "openclaw.chat": onboardingWelcome,
            [rpc.detect]: makeDetection({ manualProviders: [{ id: "openai", label: "OpenAI" }] }),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: activationFailure("401: invalid test API key", "auth"),
            [rpc.verify]: pendingVerification,
          },
        });

        await page.goto(
          `${suite.server.baseUrl}settings/model-setup?firstRun=1#bootstrapToken=e2e-first-grant&bootstrapProfile=owner`,
        );
        const firstConnect = connectParams((await gateway.waitForRequest("connect")).params);
        expect(firstConnect.auth).toMatchObject({ bootstrapToken: "e2e-first-grant" });
        await page.locator(".model-setup-provider-select__trigger").click();
        await page.locator('[data-manual-provider="openai"]').click();
        const apiKey = page.locator('.model-setup__manual input[type="password"]');
        await apiKey.fill("invalid-test-key");
        await page.getByRole("button", { name: "Connect & verify" }).click();
        await page.getByText("401: invalid test API key").waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        expect(await gateway.getRequests(rpc.verify)).toHaveLength(0);

        await button(page.locator("openclaw-modal-dialog"), "Close").click();
        await gateway.setMethodResponse(
          rpc.next,
          activated(modelRef, { gatewayRestartRequired: true }),
        );
        const initialRefreshes = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await apiKey.fill("accepted-test-key");
        await page.getByRole("button", { name: "Connect & verify" }).click();
        // The activation response has arrived, but its refresh has not. A
        // restart here must retain the confirmed model without reactivating it.
        await pollRequestCount(gateway, "config.get").toBeGreaterThan(initialRefreshes);
        await gateway.setMethodResponse(rpc.detect, detection(modelRef));
        let destination = page;
        let reconnectedGateway = gateway;
        if (restart === "reopen") {
          await page.close();
          destination = await context.newPage();
          reconnectedGateway = await installMockGateway(destination, {
            featureMethods: [rpc.detect, rpc.verify, "openclaw.chat", "openclaw.chat.history"],
            methodResponses: {
              "openclaw.chat.history": { turns: [] },
              "openclaw.chat": onboardingWelcome,
              [rpc.detect]: detection(modelRef),
              [rpc.verify]: pendingVerification,
            },
          });
          await destination.goto(
            `${suite.server.baseUrl}#bootstrapToken=e2e-next-grant&bootstrapProfile=owner`,
          );
          const reopened = connectParams(
            (await reconnectedGateway.waitForRequest("connect")).params,
          );
          expect(reopened).toMatchObject({
            auth: { bootstrapToken: "e2e-next-grant" },
            device: { id: firstConnect.device?.id },
          });
        } else {
          await gateway.closeLatest(1012, "first-run activation restart");
        }
        await reconnectedGateway.waitForRequest(rpc.verify);
        await destination.getByText(pendingVerification.error, { exact: false }).waitFor();
        expect(new URL(destination.url()).pathname).toBe("/settings/model-setup");
        expect(await reconnectedGateway.getRequests("openclaw.chat")).toHaveLength(0);

        await reconnectedGateway.setMethodResponse(rpc.verify, {
          ok: true,
          modelRef,
          latencyMs: 31,
        });
        await destination.getByRole("button", { name: "Verify & use selected model" }).click();
        await expect.poll(() => new URL(destination.url()).pathname).toBe("/custodian");
        if (restart === "reconnect") {
          expect(await gateway.getRequests(rpc.activate)).toHaveLength(2);
          const connections = await gateway.getRequests("connect");
          const auth = connectParams(connections.at(-1)?.params).auth;
          expect(auth).toMatchObject({ deviceToken: "e2e-device-token" });
          expect(auth).not.toHaveProperty("bootstrapToken");
        } else {
          expect(await reconnectedGateway.getRequests(rpc.activate)).toHaveLength(0);
        }
        await destination.getByText(onboardingWelcome.reply, { exact: true }).waitFor();
        const welcomeRequest = await reconnectedGateway.waitForRequest("openclaw.chat");
        expect(welcomeRequest.params).toMatchObject({ welcomeVariant: "onboarding" });
        await destination.locator(".custodian__header--minimal").waitFor();
        expect(new URL(destination.url()).searchParams.get("onboarding")).toBe("1");
      });
    },
  );

  it.each(["clicked candidate", "prepared model", "provider sign-in"])(
    "retains %s first-run activation before refresh reconnects",
    async (entry) => {
      await suite.withPage(setupContext(), async ({ page }) => {
        const modelRef = "openai/gpt-5.6-luna";
        const gateway = await installMockGateway(page, {
          featureMethods: [
            rpc.detect,
            rpc.activate,
            rpc.verify,
            rpc.auth,
            rpc.prepare,
            rpc.next,
            "openclaw.chat",
            "openclaw.chat.history",
          ],
          methodResponses: {
            "openclaw.chat.history": { turns: [] },
            "openclaw.chat": onboardingWelcome,
            [rpc.detect]: makeDetection({
              candidates:
                entry === "clicked candidate"
                  ? [
                      candidate("openai-api-key", "OpenAI", modelRef, {
                        detail: "Detected access",
                        credentials: false,
                      }),
                    ]
                  : [],
              prepareOptions: [{ id: "local", label: "Local model", actionLabel: "Prepare model" }],
              authOptions: [providerLogin],
            }),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.auth]: runningWizard("auth-session"),
            [rpc.prepare]: runningWizard("prepare-session"),
            [rpc.next]: {
              sequence: [
                ...(entry === "prepared model"
                  ? [{ done: true, status: "done", preparedModelRef: modelRef }]
                  : []),
                activated(modelRef, { gatewayRestartRequired: true }),
              ],
            },
            [rpc.verify]: { ok: true, modelRef, latencyMs: 31 },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        await page.locator(".model-setup__intro").waitFor();
        // Preparation refreshes once before its separate activation. Hold the
        // activation response so only that mutation's refresh is interrupted.
        let refreshes = (await gateway.getRequests("config.get")).length;
        if (entry === "prepared model") {
          await gateway.deferNext(rpc.activate);
        } else {
          await gateway.deferNext("config.get");
        }
        if (entry === "clicked candidate") {
          await page.getByRole("button", { name: "Test & use" }).click();
        } else if (entry === "prepared model") {
          await page.getByRole("button", { name: "Prepare model" }).click();
        } else {
          await page.locator('[data-auth-choice="provider-login"] button').click();
        }
        if (entry === "prepared model") {
          await gateway.waitForRequest(rpc.activate);
          await gateway.deferNext("config.get");
          refreshes = (await gateway.getRequests("config.get")).length;
          await gateway.resolveDeferred(rpc.activate);
        } else {
          await gateway.waitForRequest(entry === "clicked candidate" ? rpc.activate : rpc.next);
        }
        await pollRequestCount(gateway, "config.get").toBeGreaterThan(refreshes);
        await gateway.setMethodResponse(rpc.detect, detection(modelRef));
        await gateway.closeLatest(1012, "activation refresh restart");
        await gateway.waitForRequest(rpc.verify);
        await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
        expect(new URL(page.url()).searchParams.get("onboarding")).toBe("1");
        await page.getByText(onboardingWelcome.reply, { exact: true }).waitFor();
        expect(await gateway.getRequests(rpc.activate)).toHaveLength(
          entry === "provider sign-in" ? 0 : 1,
        );
      });
    },
  );

  it("re-detects once and replaces stale visible model state after reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const discoveredModel = (name: string) => ({
        ...detection("provider/configured-model"),
        candidates: [candidate("provider-auto:provider", name, `provider/${name}`)],
      });
      const gateway = await installSetupGateway(page, {
        featureMethods: [rpc.detect],
        methodResponses: { [rpc.detect]: discoveredModel("original-model") },
      });

      const response = await openModelSetup(page, suite.server.baseUrl);
      expect(response?.status()).toBe(200);
      await page.getByText("original-model", { exact: true }).waitFor();
      const initialDetections = (await gateway.getRequests(rpc.detect)).length;
      const initialConnections = (await gateway.getRequests("connect")).length;
      await gateway.setMethodResponse(rpc.detect, discoveredModel("reconnected-model"));
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "model setup reconnect proof");
      await expectCount(page.getByText("original-model", { exact: true }), 0);
      await pollRequestCount(gateway, "connect").toBeGreaterThan(initialConnections);
      await gateway.resolveDeferred("connect");
      await pollRequestCount(gateway, rpc.detect).toBe(initialDetections + 1);
      await page.getByText("reconnected-model", { exact: true }).waitFor();
      expect(pageErrors).toEqual([]);
    });
  });
});
