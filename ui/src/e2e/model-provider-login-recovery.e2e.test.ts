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

async function startSignIn(
  page: Page,
  replies: { next?: () => unknown; config?: () => unknown } = {},
) {
  // The sign-in tab is the provider's; this proof stays on the Control UI page.
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const config = { agents: { defaults: { model: "example/existing" } } };
  const configSnapshot = {
    config,
    sourceConfig: config,
    hash: "models-login-recovery",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
  const gateway = await installMockGateway(
    page,
    {
      featureMethods: [...defaultControlUiFeatureMethods, "models.authLogin", "wizard.next"],
      methodResponses: {
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
    {
      requestHandlers: {
        "wizard.next": () => replies.next?.() ?? pasteStep,
        "config.get": () => replies.config?.() ?? configSnapshot,
      },
    },
  );
  // First-run setup lands here on the provider catalog; a reload reopens the same address.
  // The provider's only way in is the browser sign-in, so Connect starts it directly.
  await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
  await page.locator('[data-models-catalog-provider="example"] button').click();
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

  it("reopens the sign-in after a socket drop interrupts the reloaded page's restore", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let holdConfig = false;
      // Never settles: only the socket close ends the reloaded page's config read.
      const held = Promise.withResolvers<void>();
      const { gateway, paste } = await startSignIn(page, {
        config: () => {
          if (!holdConfig) {
            return undefined;
          }
          holdConfig = false;
          return held.promise;
        },
      });
      holdConfig = true;
      await page.reload();
      // The restore waits for config; the socket closes before it arrives.
      await expect.poll(() => holdConfig).toBe(false);
      await gateway.closeLatest(1006, "phone dropped the socket again");
      await paste.waitFor();
      expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
    });
  });

  it("says the sign-in ended when the reloaded page finds no session, once", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let next: unknown = pasteStep;
      await startSignIn(page, { next: () => next });
      // The Gateway lost the sign-in (restart, timeout or replacement) while the page was away.
      next = wizardNotFound;
      await page.reload();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByText("This sign-in session ended.", { exact: false }).waitFor();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.reload();
      await page.locator("[data-models-catalog-provider]").first().waitFor();
      expect(await dialog.getByText("This sign-in session ended.").count()).toBe(0);
    });
  });
});
