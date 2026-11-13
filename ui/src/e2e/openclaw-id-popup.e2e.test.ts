import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "OpenClaw ID sign-in popup",
  browserLaunchOptions: {
    headless: !process.env.OCID_POPUP_HEADED,
  },
});

suite.define(() => {
  it("opens a usable detached sign-in window from the account menu", async () => {
    // No emulated viewport: the popup must use its real window.open dimensions.
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: null },
      async ({ page, context }) => {
        // Resize only the parent; Chromium launch dimensions would override the popup too.
        const cdp = await context.newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 100, top: 40, width: 1280, height: 900 },
        });
        await cdp.detach();
        const authorizationUrl = "https://issuer.example.test/authorize";
        await context.route(authorizationUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui;margin:0;background:#f5f5f5}main{box-sizing:border-box;max-width:440px;margin:48px auto;padding:32px;background:white}label,input,button{display:block;margin:24px 0}input{box-sizing:border-box;width:100%;padding:12px}button{padding:12px 24px}</style></head><body><main><h1>Sign in</h1><p>Synthetic OpenClaw ID issuer fixture</p><label>Email<input type="email" placeholder="you@example.test"></label><button>Continue</button></main></body></html>`,
          }),
        );
        const scenario = {
          sessionKey: "agent:main:popup-proof",
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "openclawId.status",
            "openclawId.authority",
          ],
          methodResponses: {
            "openclawId.authority": { authorizationUrl, state: "synthetic-popup" },
            "openclawId.status": {
              status: { state: "on", tunnel: { state: "running", relayOnline: true } },
              channel: "local_operator",
              accountSignIn: "popup",
              owner: true,
              ownerDeviceCount: 2,
              connection: {
                kind: "local",
                accountEmail: "owner@example.test",
                accountName: "Demo owner",
              },
              link: { linked: true, hostname: "demo-claw.crabd.xyz" },
              services: {
                issuerUrl: "https://issuer.example.test",
                clientId: "control-ui",
                loaderDomain: "claws.example.test",
              },
            },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ...createControlUiMockBootstrapConfig(scenario),
              openclawIdEnabled: true,
            }),
          }),
        );
        await page.goto(`${suite.server.baseUrl}/new`);
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
        await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
        const menu = page.locator('.sidebar-identity-menu[data-phase="open"]');
        await menu.waitFor();
        await gateway.waitForRequest("openclawId.status");
        const button = menu.getByRole("button", { name: "Sign in with OpenClaw ID", exact: true });
        await button.waitFor();
        if (process.env.OCID_POPUP_EVIDENCE) {
          await page.screenshot({ path: `${suite.artifactDir}/account-menu.png` });
        }
        const [popup] = await Promise.all([context.waitForEvent("page"), button.click()]);
        await popup.waitForURL(authorizationUrl);
        await popup.getByRole("button", { name: "Continue" }).waitFor();
        await gateway.waitForRequest("openclawId.authority");
        const geometry = await popup.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          outerHeight,
          left: screenX,
          top: screenY,
          openerDetached: opener === null,
        }));
        const parent = await page.evaluate(() => ({
          left: screenX,
          top: screenY,
          width: outerWidth,
          height: outerHeight,
          availableWidth: screen.availWidth,
          availableHeight: screen.availHeight,
        }));
        if (process.env.OCID_POPUP_EVIDENCE) {
          await popup.screenshot({
            path: `${suite.artifactDir}/popup.png`,
            animations: "disabled",
          });
          await writeFile(
            `${suite.artifactDir}/geometry.json`,
            JSON.stringify({ geometry, parent }, null, 2),
          );
        }
        expect(geometry.openerDetached).toBe(true);
        expect(geometry.width).toBe(Math.min(520, parent.availableWidth));
        // Chromium caps the whole window to the screen, leaving less content space for chrome.
        const chromeHeight = geometry.outerHeight - geometry.height;
        const expectedHeight = Math.min(720, parent.availableHeight - chromeHeight);
        expect(Math.abs(geometry.height - expectedHeight)).toBeLessThanOrEqual(1);
        const form = await popup.locator("main").boundingBox();
        if (!form) {
          throw new Error("Sign-in form is not visible");
        }
        expect(form.y + form.height).toBeLessThanOrEqual(geometry.height);
        expect(form.x + form.width).toBeLessThanOrEqual(geometry.width);
        // Chromium's window manager may constrain requested placement to the work area.
        expect(geometry.left).toBeGreaterThan(parent.left);
        await popup.close();
      },
    );
  });
});
