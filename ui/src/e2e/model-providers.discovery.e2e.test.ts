import { expect, it } from "vitest";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import * as setup from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway } from "./model-setup.test-support.ts";

const rpc = setup.setupRpc;
const suite = createControlUiE2eSuite({
  name: "Models discovery credential recovery",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps the discovery action label while the setup module loads", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/model-setup/model-setup-page.tsx"),
      );
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
      const discover = page.locator("[data-models-login-discover]");
      const label = ((await discover.textContent()) ?? "").trim();
      await discover.click();
      await held.request;
      await expect
        .poll(() => page.getByRole("dialog", { name: label, exact: true }).isVisible())
        .toBe(true);
    });
  });

  it.each([
    { kind: "auth", loseAccess: false },
    { kind: "prepare", loseAccess: false },
    { kind: "auth", loseAccess: true },
    { kind: "prepare", loseAccess: true },
  ] as const)(
    "preserves the embedded $kind owner across reconnect (access lost: $loseAccess)",
    async ({ kind, loseAccess }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const startMethod = rpc[kind];
        const gateway = await installSetupGateway(page, {
          featureMethods: [rpc.detect, startMethod, rpc.next, rpc.cancel, "wizard.status"],
          methodResponses: {
            [rpc.detect]: setup.makeDetection({
              setupComplete: true,
              authOptions: [
                { id: "setup-only", label: "Setup account", kind: "oauth", featured: true },
              ],
              prepareOptions: [
                { id: "ollama", brandId: "ollama", label: "Ollama", actionLabel: "Set up model" },
              ],
            }),
            [startMethod]: setup.runningWizard(),
            [rpc.next]: setup.runningStep("account", "text", "Setup account name"),
            [rpc.cancel]: { status: "cancelled" },
            "wizard.status": { status: "cancelled" },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers?connect=1");
        await page.locator("[data-models-login-discover]").click();
        const choice = kind === "auth" ? "setup-only" : "ollama";
        await page.locator(`[data-${kind}-choice="${choice}"] button`).click();
        const started = await gateway.waitForRequest(startMethod);
        const input = page.locator('input[name="wizard-text"]');
        await input.fill("Draft account");
        const embedded = await page.locator("openclaw-model-setup-page").elementHandle();
        const nextCount = (await gateway.getRequests(rpc.next)).length;
        if (loseAccess) {
          await gateway.setOperatorScopes(["operator.read"]);
        }
        await reconnectMockGateway(page, gateway);
        expect(await embedded!.evaluate((element) => element.isConnected)).toBe(true);
        if (loseAccess) {
          expect(await input.count()).toBe(0);
          expect(await gateway.getRequests(rpc.next)).toHaveLength(nextCount);
        } else {
          const resumed = await gateway.waitForRequest(rpc.next, { after: nextCount });
          expect(resumed.params).toEqual(
            started.params && typeof started.params === "object" && "sessionId" in started.params
              ? { sessionId: started.params.sessionId }
              : null,
          );
          await expect.poll(() => input.isEnabled()).toBe(true);
          expect(await input.inputValue()).toBe("Draft account");
        }
        expect(await gateway.getRequests(rpc.cancel)).toHaveLength(0);
        expect(await gateway.getRequests(startMethod)).toHaveLength(1);
      });
    },
  );
});
