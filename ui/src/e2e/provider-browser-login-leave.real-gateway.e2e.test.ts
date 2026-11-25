import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  loginOrigin,
  loginProvider,
  startProviderBrowserLoginFixture,
} from "./provider-browser-login.test-support.ts";

// A phone user leaves the Control UI for the provider's page: the socket drops, or the
// browser discards and reloads the tab. The same sign-in must still be there and finish.
let fixture: Awaited<ReturnType<typeof startProviderBrowserLoginFixture>>;
const browserArgs: string[] = [];
const loginLabel = "Fixture browser sign-in";
const suite = createControlUiE2eSuite({
  name: "Provider sign-in survives leaving the tab",
  startServerBeforeBrowser: true,
  browserLaunchOptions: { args: browserArgs },
  async startServer() {
    fixture = await startProviderBrowserLoginFixture();
    browserArgs.push(
      `--host-resolver-rules=MAP files.proxy.test:443 127.0.0.1:${fixture.edgePort}`,
      "--no-proxy-server",
    );
    return {
      baseUrl: fixture.baseUrl,
      close: () =>
        runQaGatewayFixture(
          () => fs.writeFile(path.join(suite.artifactDir, "gateway.log"), fixture.instance.logs()),
          () => fixture.close(),
        ),
    };
  },
});

async function connect(page: Page): Promise<void> {
  await page.goto(`${loginOrigin}/settings/model-providers`);
  const secret = page.getByLabel("Gateway secret", { exact: true });
  await secret.waitFor();
  await secret.fill(fixture.instance.gatewayToken);
  await page.locator(".login-gate__connect").click();
  await page.locator('[data-kind="pairing-required"]').waitFor();
  const devices = await fixture.instance.cli(["devices", "list", "--json"]);
  expect(devices.code, devices.stderr).toBe(0);
  const pending = JSON.parse(devices.stdout).pending;
  expect(pending).toHaveLength(1);
  const approved = await fixture.instance.cli(["devices", "approve", pending[0].requestId]);
  expect(approved.code, approved.stderr).toBe(0);
  await waitForControlUiGatewayReady(page);
}

async function beginSignIn(page: Page, context: BrowserContext): Promise<Page> {
  await page.locator("[data-models-catalog-search]").fill(loginProvider);
  await page.locator(`[data-models-catalog-provider="${loginProvider}"] button`).click();
  const method = page
    .locator("openclaw-modal-dialog")
    .getByRole("button", { name: loginLabel, exact: true });
  const link = page.locator(".wizard-step__external-link");
  await method.or(link).first().waitFor();
  if (await method.isVisible()) {
    await method.click();
  }
  await link.waitFor();
  const popup = context.waitForEvent("page");
  await link.click();
  const providerPage = await popup;
  await providerPage.getByRole("heading", { name: "Authorize fixture account" }).waitFor();
  return providerPage;
}

async function finishSignIn(page: Page, providerPage: Page): Promise<void> {
  // The dialog the user came back to still waits for this sign-in's provider callback.
  await page.locator("openclaw-modal-dialog").getByText(loginLabel).first().waitFor();
  const callback = providerPage.waitForResponse(
    (response) => new URL(response.url()).pathname === "/oauth/provider/callback",
  );
  await providerPage.getByRole("button", { name: "Approve sign-in" }).click();
  expect((await callback).status()).toBe(200);
  await page
    .locator("openclaw-modal-dialog")
    .getByRole("heading", { name: `${loginLabel} is ready`, exact: true })
    .waitFor();
}

const pageOptions = {
  ignoreHTTPSErrors: true,
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
} as const;

suite.define(() => {
  it("finishes the sign-in after the socket drops and reconnects", async () => {
    await suite.withPage(pageOptions, async ({ page, context }) => {
      await connect(page);
      const providerPage = await beginSignIn(page, context);
      await context.setOffline(true);
      await page.getByText("Disconnected. Waiting to reconnect…", { exact: true }).waitFor();
      await context.setOffline(false);
      await waitForControlUiGatewayReady(page, 30_000);
      await finishSignIn(page, providerPage);
    });
  }, 120_000);

  it("finishes the sign-in after the page reloads", async () => {
    await suite.withPage(pageOptions, async ({ page, context }) => {
      await connect(page);
      const providerPage = await beginSignIn(page, context);
      await page.reload();
      await waitForControlUiGatewayReady(page, 30_000);
      await finishSignIn(page, providerPage);
    });
  }, 120_000);
});
