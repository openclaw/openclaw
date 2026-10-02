// Real Control UI rendering and routing; provider/Gateway replies are controlled fixtures.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  activationFailure,
  button,
  candidate,
  expectRequestCounts,
  makeDetection,
  runningStep,
  runningWizard,
  setupContext,
  setupPages,
  setupRpc as rpc,
  waitText,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Explicit AI onboarding",
  startServerBeforeBrowser: true,
});

const withPage = setupPages(suite, () => setupContext({ viewport: { width: 1080, height: 850 } }));
const detection = makeDetection({
  candidates: [
    candidate("codex-cli", "Codex", "openai/gpt-5", {
      detail: "Available credentials",
      recommended: true,
    }),
    candidate("anthropic-api-key", "Anthropic", "anthropic/claude-sonnet-4-6", {
      detail: "Available credentials",
    }),
  ],
  manualProviders: [{ id: "openai", label: "OpenAI" }],
  authOptions: [
    { id: "meta-api-key", label: "Meta", kind: "install", featured: false },
    { id: "custom-api-key", label: "Custom compatible endpoint", kind: "custom", featured: false },
  ],
  nativeSessionCatalogs: [
    { pluginId: "anthropic", label: "Claude" },
    { pluginId: "codex", label: "Codex" },
  ],
  nativeSessionCatalogPreferenceRequired: true,
  setupComplete: false,
  workspace: "/tmp/onboarding-fixture",
});

suite.define(() => {
  it.each(["", "?firstRun=1", "?firstRun=explicit"])(
    "waits for an explicit choice on %s and preserves provider failure details",
    async (query) => {
      await withPage(async ({ page }) => {
        const installGateway = query ? installMockGateway : installSetupGateway;
        const gateway = await installGateway(page, {
          featureMethods: [rpc.detect, rpc.activate, rpc.auth, rpc.next],
          methodResponses: {
            [rpc.detect]: detection,
            [rpc.activate]: activationFailure(
              "HTTP 401: review this provider credential and try again.",
              "auth",
            ),
          },
        });
        if (query) {
          await page.goto(suite.server.baseUrl + "settings/model-setup" + query);
        } else {
          await openModelSetup(page, suite.server.baseUrl);
        }
        await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
        const choices = page.locator("[data-candidate-kind]");
        expect(await choices.first().textContent()).toContain("Anthropic");
        expect(await page.getByLabel("Show existing native conversations").isChecked()).toBe(false);
        expect(await page.locator("openclaw-model-setup-page [data-selected]").count()).toBe(0);
        await button(page, "Check again").click();
        await gateway.waitForRequest(rpc.detect, { after: 1 });
        await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
        await expectRequestCounts(gateway, {
          [rpc.activate]: 0,
          [rpc.auth]: 0,
          "plugins.install": 0,
          [rpc.verify]: 0,
          "config.set": 0,
          "config.patch": 0,
          "config.apply": 0,
        });

        await page.locator('[data-candidate-kind="anthropic-api-key"] button').click();
        const activation = await gateway.waitForRequest(rpc.activate);
        expect(activation.params).toMatchObject({
          kind: "anthropic-api-key",
          nativeSessionCatalogsEnabled: false,
        });
        await waitText(page, "HTTP 401: review this provider credential and try again.", false);
        expect(await gateway.getRequests(rpc.activate)).toHaveLength(1);
      });
    },
  );

  it("starts managed provider installation only after a click and waits at capability consent", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [rpc.detect, rpc.auth, rpc.next, rpc.cancel],
        methodResponses: {
          [rpc.detect]: detection,
          [rpc.auth]: runningWizard(),
          [rpc.next]: runningStep(
            "capabilities",
            "confirm",
            "Allow this provider plugin to call its inference endpoint?",
            { initialValue: false },
          ),
          [rpc.cancel]: { status: "cancelled" },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/model-setup?firstRun=1");
      const install = page
        .locator('[data-auth-choice="meta-api-key"]')
        .getByRole("button", { name: "Review & install" });
      await install.waitFor();
      expect(await gateway.getRequests(rpc.auth)).toHaveLength(0);
      expect(
        await page
          .locator('[data-auth-choice="custom-api-key"]')
          .getByRole("button", { name: "Set up endpoint" })
          .isVisible(),
      ).toBe(true);
      await page.getByLabel("Show existing native conversations").check();
      await install.click();
      expect((await gateway.waitForRequest(rpc.auth)).params).toMatchObject({
        authChoice: "meta-api-key",
        nativeSessionCatalogsEnabled: true,
      });
      const dialog = page.locator("openclaw-modal-dialog");
      await waitText(dialog, "Allow this provider plugin to call its inference endpoint?");
      const next = await gateway.getRequests(rpc.next);
      expect(next).toHaveLength(1);
      expect(next[0]!.params).not.toHaveProperty("answer");

      await button(dialog, "Cancel").click();
      await gateway.waitForRequest(rpc.cancel);
      expect(await gateway.getRequests(rpc.auth)).toHaveLength(1);
    });
  });

  it("continues Meta capability review into its auth form, then relaunches without replay", async () => {
    await withPage(async ({ page, context }) => {
      const modelRef = "meta/fixture-model";
      const gateway = await installSetupGateway(page, {
        featureMethods: [rpc.detect, rpc.auth, rpc.next, rpc.cancel, rpc.verify],
        methodResponses: {
          [rpc.detect]: detection,
          [rpc.auth]: runningWizard(),
          [rpc.next]: runningStep(
            "meta-capabilities",
            "confirm",
            "Accept Meta provider capabilities?",
            { initialValue: false },
          ),
        },
      });
      await openModelSetup(page, suite.server.baseUrl);
      await page.locator('[data-auth-choice="meta-api-key"] button').click();
      const start = await gateway.waitForRequest(rpc.auth);
      expect(start.params).toMatchObject({
        agentId: "main",
        authChoice: "meta-api-key",
        nativeSessionCatalogsEnabled: false,
      });
      const dialog = page.locator("openclaw-modal-dialog");
      await waitText(dialog, "Accept Meta provider capabilities?");

      await gateway.setMethodResponse(
        rpc.next,
        runningStep("meta-api-key", "text", "Meta API key", { sensitive: true }),
      );
      await button(dialog, "Yes").click();
      const key = dialog.getByLabel("Meta API key", { exact: true });
      await key.waitFor();

      await key.fill("synthetic-meta-api-key");
      await gateway.setMethodResponse(rpc.next, activated(modelRef));
      await button(dialog, "Submit").click();
      await page.locator(".model-setup-success").waitFor();
      const nextRequests = await gateway.getRequests(rpc.next);
      expect(nextRequests.map(({ params }) => params)).toEqual([
        { sessionId: expect.any(String) },
        { sessionId: expect.any(String), answer: { stepId: "meta-capabilities", value: true } },
        {
          sessionId: expect.any(String),
          answer: { stepId: "meta-api-key", value: "synthetic-meta-api-key" },
        },
      ]);

      const relaunched = await context.newPage();
      const afterRelaunch = await installMockGateway(relaunched, {
        featureMethods: [rpc.detect, rpc.auth, rpc.activate, rpc.verify],
        methodResponses: {
          [rpc.detect]: {
            ...detection,
            configuredModel: modelRef,
            setupComplete: true,
            nativeSessionCatalogPreferenceRequired: false,
          },
        },
      });
      await relaunched.goto(suite.server.baseUrl + "settings/model-setup?firstRun=explicit");
      await relaunched.locator(".model-setup__current").waitFor();
      await expectRequestCounts(afterRelaunch, {
        [rpc.auth]: 0,
        [rpc.activate]: 0,
        [rpc.verify]: 0,
      });
    });
  });

  it.each(["success", "failure", "cancel", "remote"] as const)(
    "keeps custom endpoint %s on the selected provider",
    async (outcome) => {
      await withPage(
        async ({ page }) => {
          const gateway = await installSetupGateway(page, {
            featureMethods: [rpc.detect, rpc.auth, rpc.next, rpc.cancel],
            methodResponses: {
              [rpc.detect]: detection,
              [rpc.auth]:
                outcome === "remote"
                  ? activationFailure(
                      "Run openclaw onboard on the Gateway host to configure this custom endpoint.",
                      "unavailable",
                    )
                  : runningWizard(),
              [rpc.cancel]: { status: "cancelled" },
              [rpc.next]: runningStep("endpoint", "text", "API base URL"),
            },
          });
          await openModelSetup(page, suite.server.baseUrl);
          await page.locator('[data-auth-choice="custom-api-key"] button').click();
          expect((await gateway.waitForRequest(rpc.auth)).params).toMatchObject({
            authChoice: "custom-api-key",
            agentId: "main",
          });
          const dialog = page.locator("openclaw-modal-dialog");
          if (outcome === "remote") {
            const alert = dialog.getByRole("alert");
            await alert.waitFor();
            const diagnosticText =
              "Run openclaw onboard on the Gateway host to configure this custom endpoint.";
            const diagnostic = alert.getByText(diagnosticText, { exact: true });
            await diagnostic.waitFor();
            expect(
              await diagnostic.evaluate((element) => {
                const { userSelect, overflowY } = getComputedStyle(element);
                return { userSelect, overflowY };
              }),
            ).toEqual({ userSelect: "text", overflowY: "auto" });

            await button(alert, "Copy").click();
            await expect
              .poll(() => page.evaluate(() => navigator.clipboard.readText()))
              .toBe(diagnosticText);
            expect(await dialog.locator("details").count()).toBe(0);
            await expectRequestCounts(gateway, { [rpc.next]: 0, [rpc.auth]: 1 });
            return;
          }
          await dialog.getByLabel("API base URL", { exact: true }).fill("http://127.0.0.1:9876/v1");

          if (outcome === "cancel") {
            await button(dialog, "Cancel").click();
            await gateway.waitForRequest(rpc.cancel);
            expect(await gateway.getRequests(rpc.next)).toHaveLength(1);
          } else {
            await gateway.setMethodResponse(
              rpc.next,
              outcome === "success"
                ? activated("custom/fixture-model")
                : activationFailure(
                    "The selected endpoint could not be reached. Check its address.",
                    "unavailable",
                  ),
            );
            await button(dialog, "Submit").click();
            if (outcome === "success") {
              await page.locator(".model-setup-success").waitFor();
            } else {
              const alert = dialog.getByRole("alert");
              await alert.waitFor();
              await alert
                .getByText("The selected endpoint could not be reached. Check its address.", {
                  exact: true,
                })
                .waitFor();
              expect(await dialog.locator("details").count()).toBe(0);
            }
          }
          await expectRequestCounts(gateway, { [rpc.auth]: 1, [rpc.activate]: 0 });
        },
        { permissions: ["clipboard-read", "clipboard-write"] },
      );
    },
  );
});
