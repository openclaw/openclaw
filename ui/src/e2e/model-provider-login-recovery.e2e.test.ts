// Browser proof that a provider sign-in survives leaving the tab: the Control UI
// socket drops, or the browser discards and reloads the page.
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { wizardNotFound } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model provider login recovery",
  startServerBeforeBrowser: true,
});

const pasteStep = {
  done: false,
  status: "running",
  step: {
    id: "paste-callback",
    type: "text",
    executor: "client",
    message: "Address of the page your browser opened",
    externalUrl: "https://provider.example/sign-in",
  },
};

async function startSignIn(page: Page, nextResponse: () => unknown = () => pasteStep) {
  // The sign-in tab is the provider's; this proof stays on the Control UI page.
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const config = { agents: { defaults: { model: "example/existing" } } };
  const gateway = await installMockGateway(
    page,
    {
      featureMethods: [...defaultControlUiFeatureMethods, "models.authLogin", "wizard.next"],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "models-login-recovery",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.authStatus": {
          ts: 1,
          providers: [],
          providerCapabilities: [
            {
              provider: "example",
              apiKeySupported: false,
              quickApiKeySetup: false,
              loginOptions: [
                {
                  id: "example-browser",
                  brandId: "example",
                  label: "Example browser sign-in",
                  kind: "oauth",
                  featured: true,
                },
              ],
            },
          ],
        },
        "models.authLogin": { done: false, status: "running" },
      },
    },
    // A Node-side reply outlives the page, so a reload sees the Gateway's current answer.
    { requestHandlers: { "wizard.next": () => nextResponse() } },
  );
  // First-run setup lands here with the picker open; a reload reopens the same address.
  await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
  await page.locator('[data-models-login-provider="example"]').click();
  await page.getByRole("button", { name: "Example browser sign-in", exact: true }).click();
  const login = await gateway.waitForRequest("models.authLogin");
  const params = login.params;
  assert(params && typeof params === "object" && "sessionId" in params);
  const paste = page.locator('openclaw-modal-dialog input[name="wizard-text"]');
  await paste.fill("http://127.0.0.1:1455/callback?code=typed");
  return { gateway, paste, sessionId: params.sessionId };
}

suite.define(() => {
  it("keeps the sign-in step and typed address after the socket reconnects", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, paste, sessionId } = await startSignIn(page);
      const before = (await gateway.getRequests("wizard.next")).length;
      await gateway.closeLatest(1006, "browser left the tab");
      // The same sign-in is read again on the new socket, without an answer.
      await expect
        .poll(async () => (await gateway.getRequests("wizard.next")).length)
        .toBeGreaterThan(before);
      await paste.waitFor();
      expect(await paste.inputValue()).toBe("http://127.0.0.1:1455/callback?code=typed");
      expect(await gateway.getRequests("models.authLogin")).toHaveLength(1);
      expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
      expect((await gateway.getRequests("wizard.next")).at(-1)?.params).toEqual({ sessionId });
    });
  });

  it("reopens the sign-in step after the page reloads", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, paste, sessionId } = await startSignIn(page);
      await page.reload();
      await paste.waitFor();
      await page
        .locator("openclaw-modal-dialog")
        .getByText("Example browser sign-in", { exact: false })
        .first()
        .waitFor();
      expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
      expect((await gateway.getRequests("wizard.next"))[0]?.params).toEqual({ sessionId });
    });
  });

  it("says the sign-in ended when the reloaded page finds no session", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let next: unknown = pasteStep;
      await startSignIn(page, () => next);
      // The Gateway lost the sign-in (restart, timeout or replacement) while the page was away.
      next = wizardNotFound;
      await page.reload();
      await page
        .locator("openclaw-modal-dialog")
        .getByText("This sign-in session ended.", { exact: false })
        .waitFor();
    });
  });
});
