import { expect, it } from "vitest";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Models discovery credential recovery",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each([
    { kind: "auth", loseAccess: false },
    { kind: "prepare", loseAccess: false },
    { kind: "auth", loseAccess: true },
    { kind: "prepare", loseAccess: true },
  ] as const)(
    "preserves the embedded $kind owner across reconnect (access lost: $loseAccess)",
    async ({ kind, loseAccess }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const startMethod =
          kind === "auth" ? "openclaw.setup.auth.start" : "openclaw.setup.prepare.start";
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "config.get",
            "config.patch",
            "models.authStatus",
            "models.list",
            "openclaw.setup.detect",
            startMethod,
            "wizard.next",
            "wizard.cancel",
            "wizard.status",
          ],
          methodResponses: {
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
            "openclaw.setup.detect": {
              candidates: [],
              manualProviders: [],
              setupComplete: true,
              workspace: "/synthetic/workspace",
              authOptions: [
                { id: "setup-only", label: "Setup account", kind: "oauth", featured: true },
              ],
              prepareOptions: [
                { id: "ollama", brandId: "ollama", label: "Ollama", actionLabel: "Set up model" },
              ],
            },
            [startMethod]: { done: false, status: "running" },
            "wizard.next": {
              done: false,
              status: "running",
              step: { id: "account", type: "text", message: "Setup account name" },
            },
            "wizard.cancel": { status: "cancelled" },
            "wizard.status": { status: "cancelled" },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers?connect=1");
        await page.locator("[data-models-login-discover]").click();
        await page
          .locator(
            kind === "auth"
              ? '[data-auth-choice="setup-only"] button'
              : '[data-prepare-choice="ollama"] button',
          )
          .click();
        const started = await gateway.waitForRequest(startMethod);
        const input = page.locator('input[name="wizard-text"]');
        await input.fill("Draft account");
        const embedded = await page.locator("openclaw-model-setup-page").elementHandle();
        const nextCount = (await gateway.getRequests("wizard.next")).length;
        if (loseAccess) {
          await gateway.setOperatorScopes(["operator.read"]);
        }
        await reconnectMockGateway(page, gateway);
        expect(await embedded!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await gateway.getRequests(startMethod)).toHaveLength(1);
        if (loseAccess) {
          expect(await input.count()).toBe(0);
          expect(await gateway.getRequests("wizard.next")).toHaveLength(nextCount);
        } else {
          const resumed = await gateway.waitForRequest("wizard.next", { after: nextCount });
          expect(resumed.params).toEqual(
            started.params && typeof started.params === "object" && "sessionId" in started.params
              ? { sessionId: started.params.sessionId }
              : null,
          );
          await expect.poll(() => input.isEnabled()).toBe(true);
          expect(await input.inputValue()).toBe("Draft account");
        }
        expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
        expect(await gateway.getRequests(startMethod)).toHaveLength(1);
      });
    },
  );

  it.each(["auth", "manual"] as const)(
    "recovers an aliased provider through the exact %s credential method",
    async (kind) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const choice = {
          id: "fixture/account-key",
          brandId: "account-brand",
          groupLabel: "Account brand",
          label: "Account key",
          kind: "secret",
          featured: false,
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "config.get",
            "config.patch",
            "models.authStatus",
            "models.list",
            "models.authLogin",
            "openclaw.setup.detect",
            "wizard.next",
          ],
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                {
                  provider: "credential-owner",
                  apiKeySupported: true,
                  quickApiKeySetup: false,
                  loginOptions: [
                    { ...choice, id: "fixture/browser", label: "Browser sign-in", kind: "oauth" },
                    choice,
                  ],
                },
              ],
            },
            "openclaw.setup.detect": {
              candidates: [],
              setupComplete: false,
              workspace: "/synthetic/workspace",
              authOptions: kind === "auth" ? [choice] : [],
              manualProviders: kind === "manual" ? [choice] : [],
              unavailableCandidates: [
                {
                  id: "expired-account",
                  label: "Account brand",
                  detail: "Saved credential expired",
                  reason: "Connect the account again",
                  ...(kind === "auth"
                    ? { authOptionId: choice.id }
                    : { manualProviderId: choice.id }),
                },
              ],
            },
            "models.authLogin": { done: false, status: "running" },
            "wizard.next": {
              done: false,
              status: "running",
              step: { id: "key", type: "text", sensitive: true, message: "Enter account key" },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
        await page.locator("[data-models-login-discover]").click();
        await page.locator('[data-unavailable-candidate="expired-account"] button').click();
        const method = page
          .locator("[data-models-login-choice]")
          .getByRole("button", { name: choice.label, exact: true });
        await method.waitFor();
        expect(await page.locator(".model-provider-login__provider").textContent()).toContain(
          "Account brand",
        );
        expect(await page.locator(".model-setup-discovery").count()).toBe(0);
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        await method.click();
        expect((await gateway.waitForRequest("models.authLogin")).params).toMatchObject({
          authChoice: choice.id,
          agentId: "main",
        });
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    },
  );
});
