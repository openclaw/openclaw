// Control UI tests cover browser-native device-token isolation and reuse.
import path from "node:path";
import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let proofDir: string | undefined;
beforeEach(() => {
  proofDir = artifactRoot
    ? createControlUiE2eArtifactDir("device-token-reconnect", artifactRoot)
    : undefined;
});

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
const ROSITA_GATEWAY_URL = "wss://gateway.example/rosita";
const WILFRED_GATEWAY_URL = "wss://gateway.example/wilfred";
const ROSITA_DEVICE_TOKEN = "rosita-device-token";
const WILFRED_DEVICE_TOKEN = "wilfred-device-token";
const WILFRED_ROTATED_TOKEN = "wilfred-rotated-device-token";

const requireRecord = createRequireRecord("record", "expected-object-value");

function readConnectAuth(request: { params?: unknown }): Record<string, unknown> | undefined {
  const auth = requireRecord(request.params).auth;
  return auth == null ? undefined : requireRecord(auth);
}

function requireConnectAuth(request: { params?: unknown }): Record<string, unknown> {
  return requireRecord(readConnectAuth(request));
}

function browserPageGatewayUrl(appBaseUrl: string): string {
  const parsed = new URL(appBaseUrl);
  const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${parsed.host}`;
}

async function selectGatewayOnNextLoad(
  page: Page,
  appBaseUrl: string,
  gatewayUrl: string,
): Promise<void> {
  const settingsKey = `openclaw.control.settings.v1:${gatewayOriginScope(gatewayUrl)}`;
  const selectionKey =
    `openclaw.control.currentGateway.v1:` + gatewayOriginScope(browserPageGatewayUrl(appBaseUrl));
  await page.addInitScript(
    ({ nextGatewayUrl, nextSelectionKey, nextSettingsKey }) => {
      localStorage.setItem(nextSettingsKey, JSON.stringify({ gatewayUrl: nextGatewayUrl }));
      localStorage.setItem(nextSelectionKey, nextGatewayUrl);
    },
    {
      nextGatewayUrl: gatewayUrl,
      nextSelectionKey: selectionKey,
      nextSettingsKey: settingsKey,
    },
  );
}

function gatewayPages(context: BrowserContext) {
  return async (
    gatewayUrl: string,
    deviceToken: string,
    {
      appBaseUrl = server.baseUrl,
      methodResponses,
      route = "chat",
      sharedToken,
    }: {
      appBaseUrl?: string;
      methodResponses?: Record<string, unknown>;
      route?: string;
      sharedToken?: string;
    } = {},
  ) => {
    const page = await context.newPage();
    await selectGatewayOnNextLoad(page, appBaseUrl, gatewayUrl);
    const gateway = await installMockGateway(page, { deviceToken, methodResponses });
    const tokenFragment = sharedToken ? `#token=${encodeURIComponent(sharedToken)}` : "";
    const response = await page.goto(`${appBaseUrl}${route}${tokenFragment}`);
    expect(response?.status()).toBe(200);
    const connect = await gateway.waitForRequest("connect");
    await page.locator("openclaw-app-shell").waitFor();
    return { connect, gateway, page };
  };
}

function storedToken(page: Page, gatewayUrl: string) {
  return page.evaluate(
    (key) => {
      const raw = localStorage.getItem(key);
      const store = raw ? (JSON.parse(raw) as { tokens?: Record<string, unknown> }) : undefined;
      return store?.tokens?.operator;
    },
    `openclaw.device.auth.v1:${gatewayCredentialScope(gatewayUrl)}`,
  );
}

async function expectForgotten(gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await expect
    .poll(async () => (await gateway.getRequests("connect")).length)
    .toBeGreaterThanOrEqual(2);
  const reconnect = await gateway.waitForRequest("connect");
  expect(readConnectAuth(reconnect)?.token).toBeUndefined();
  expect(readConnectAuth(reconnect)?.deviceToken).toBeUndefined();
}

async function openForgetDialog(page: Page) {
  await page.goto(`${server.baseUrl}settings/connection`);
  const forget = page.getByRole("button", { name: "Forget this browser", exact: true });
  await forget.waitFor({ state: "visible" });
  return forget;
}

async function createContext(): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  openContexts.add(context);
  return context;
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

describeControlUiE2e("Control UI device-token reconnect E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("isolates device tokens across gateways, origins, and revocation", async () => {
    const context = await createContext();
    const open = gatewayPages(context);
    const rositaSource = await open(ROSITA_GATEWAY_URL, ROSITA_DEVICE_TOKEN, {
      sharedToken: "shared-rosita",
    });
    expect(requireConnectAuth(rositaSource.connect)).toEqual({
      // The single secret field sends the shared secret in both connect fields.
      password: "shared-rosita",
      token: "shared-rosita",
    });

    const wilfredSource = await open(WILFRED_GATEWAY_URL, WILFRED_DEVICE_TOKEN, {
      sharedToken: "shared-wilfred",
    });
    expect(requireConnectAuth(wilfredSource.connect)).toEqual({
      // The single secret field sends the shared secret in both connect fields.
      password: "shared-wilfred",
      token: "shared-wilfred",
    });

    const rositaReconnect = await open(ROSITA_GATEWAY_URL, ROSITA_DEVICE_TOKEN, {
      route: "sessions",
    });
    expect(requireConnectAuth(rositaReconnect.connect)).toEqual({
      deviceToken: ROSITA_DEVICE_TOKEN,
    });
    expect(await rositaReconnect.page.locator("openclaw-login-gate").count()).toBe(0);
    await captureProof(rositaReconnect.page, "rosita-reconnected.png");

    const wilfredReconnect = await open(WILFRED_GATEWAY_URL, WILFRED_DEVICE_TOKEN);
    expect(requireConnectAuth(wilfredReconnect.connect)).toEqual({
      deviceToken: WILFRED_DEVICE_TOKEN,
    });
    expect(await wilfredReconnect.page.locator("openclaw-login-gate").count()).toBe(0);

    const identity = await wilfredSource.page.evaluate(() => {
      const raw = localStorage.getItem("openclaw-device-identity-v1");
      return raw ? JSON.parse(raw) : null;
    });
    const deviceId = requireRecord(identity).deviceId;
    if (typeof deviceId !== "string") {
      throw new Error("Expected the browser device identity to contain a deviceId");
    }

    const otherOriginBaseUrl = server.baseUrl.replace("127.0.0.1", "localhost");
    const otherOrigin = await open(ROSITA_GATEWAY_URL, "other-origin-device-token", {
      appBaseUrl: otherOriginBaseUrl,
    });
    expect(readConnectAuth(otherOrigin.connect)).toBeUndefined();

    const wilfredDevices = await open(WILFRED_GATEWAY_URL, WILFRED_DEVICE_TOKEN, {
      methodResponses: {
        "device.pair.list": {
          paired: [
            {
              deviceId,
              displayName: "This browser",
              roles: ["operator"],
              scopes: OPERATOR_SCOPES,
              tokens: [
                {
                  createdAtMs: Date.now(),
                  role: "operator",
                  scopes: OPERATOR_SCOPES,
                },
              ],
            },
          ],
          pending: [],
        },
        "device.token.revoke": {},
        "device.token.rotate": {
          deviceId,
          role: "operator",
          scopes: OPERATOR_SCOPES,
          token: WILFRED_ROTATED_TOKEN,
          rotatedAtMs: Date.now(),
          tokenDelivery: "in-band",
        },
        "node.list": { nodes: [] },
      },
      // Exercise the legacy /nodes alias while asserting the renamed Devices surface.
      route: "nodes",
    });
    expect(requireConnectAuth(wilfredDevices.connect)).toEqual({
      deviceToken: WILFRED_DEVICE_TOKEN,
    });
    await wilfredDevices.gateway.waitForRequest("device.pair.list");
    const deviceEntry = wilfredDevices.page.locator(".device-entry").filter({
      has: wilfredDevices.page.getByText("This browser", { exact: true }),
    });
    await deviceEntry.waitFor();
    await deviceEntry.locator("details.device-entry__details > summary").click();
    const revokeButton = deviceEntry.getByRole("button", { name: "Revoke", exact: true });
    await revokeButton.waitFor({ state: "visible" });
    await revokeButton.scrollIntoViewIfNeeded();
    await captureProof(wilfredDevices.page, "wilfred-before-revoke.png");
    await revokeButton.click();
    // Revoke confirms in-page, not through window.confirm: webviews without a dialog
    // bridge silently answer false and would drop the action with no visible outcome.
    const revokeConfirm = wilfredDevices.page.locator("openclaw-modal-dialog");
    await revokeConfirm.getByText("Revoke the operator token?").waitFor();
    await revokeConfirm.getByText(`Device ID: ${deviceId}`).waitFor();
    await revokeConfirm.getByRole("button", { name: "Revoke", exact: true }).click();
    const revoke = await wilfredDevices.gateway.waitForRequest("device.token.revoke");
    expect(revoke.params).toEqual({ deviceId, role: "operator" });
    await expect.poll(() => storedToken(wilfredDevices.page, WILFRED_GATEWAY_URL)).toBeUndefined();

    const rositaAfterRevoke = await open(ROSITA_GATEWAY_URL, ROSITA_DEVICE_TOKEN);
    expect(requireConnectAuth(rositaAfterRevoke.connect)).toEqual({
      deviceToken: ROSITA_DEVICE_TOKEN,
    });

    const wilfredAfterRevoke = await open(WILFRED_GATEWAY_URL, WILFRED_DEVICE_TOKEN);
    expect(readConnectAuth(wilfredAfterRevoke.connect)).toBeUndefined();

    // Rotation hands back the only copy of the new credential, so it is revealed in-page:
    // window.prompt rendered nothing in a webview without a dialog bridge. This runs last
    // because Escape also exits the Settings takeover behind the dialog — pre-existing
    // shell behavior shared by every modal — which must not disturb the assertions above.
    await deviceEntry.getByRole("button", { name: "Rotate", exact: true }).click();
    const rotateReveal = wilfredDevices.page.locator("openclaw-modal-dialog");
    await rotateReveal.getByText("New operator token").waitFor();
    await rotateReveal.getByText(WILFRED_ROTATED_TOKEN).waitFor();
    await captureProof(wilfredDevices.page, "wilfred-rotated-token.png");
    await wilfredDevices.page.keyboard.press("Escape");
    await rotateReveal
      .getByText("This dialog stays open until you confirm the token is saved.")
      .waitFor();
    await rotateReveal.getByText(WILFRED_ROTATED_TOKEN).waitFor({ state: "visible" });
    await rotateReveal.getByRole("button", { name: "I saved this token", exact: true }).click();
    await rotateReveal.waitFor({ state: "detached" });
  });

  it("forgets this browser's stored credential from Gateway settings", async () => {
    const context = await createContext();
    const open = gatewayPages(context);
    // Seed the stored device token through a shared-token first visit, then
    // close that page so its session token cannot mask credential selection.
    const seed = await open(ROSITA_GATEWAY_URL, ROSITA_DEVICE_TOKEN, {
      sharedToken: "shared-rosita",
    });
    expect(requireConnectAuth(seed.connect).token).toBe("shared-rosita");
    await expect.poll(() => storedToken(seed.page, ROSITA_GATEWAY_URL)).toBeDefined();
    await seed.page.close();

    // The fresh page has no shared token: this connect must ride the stored
    // device-token path, so post-forget selection cannot be masked.
    const { gateway, page } = await open(ROSITA_GATEWAY_URL, ROSITA_DEVICE_TOKEN);
    const storedConnect = await gateway.waitForRequest("connect");
    // Stored device credentials ride only auth.deviceToken; the shared token
    // slot stays empty so cached credentials never masquerade as explicit auth.
    const storedConnectAuth = requireConnectAuth(storedConnect);
    expect(storedConnectAuth).toMatchObject({ deviceToken: ROSITA_DEVICE_TOKEN });
    expect(storedConnectAuth.token).toBeUndefined();
    const identityBefore = await page.evaluate(() =>
      localStorage.getItem("openclaw-device-identity-v1"),
    );
    expect(identityBefore).not.toBeNull();

    const forgetRow = await openForgetDialog(page);
    await captureProof(page, "gateway-settings-browser-sign-in.png");
    await forgetRow.click();
    const confirmButton = page.getByRole("button", { name: "Forget", exact: true });
    await confirmButton.waitFor({ state: "visible" });
    // Proof frames must show the settled dialog, not its opening fade.
    await page
      .locator("openclaw-modal-dialog")
      .evaluate((dialog) =>
        Promise.all(dialog.getAnimations({ subtree: true }).map((entry) => entry.finished)),
      );
    await captureProof(page, "forget-device-confirm-dialog.png");
    await confirmButton.click();

    // The forget-triggered reconnect must offer no credential at all: with no
    // shared token in this tab, a surviving stored token would appear here.
    await expectForgotten(gateway);
    await captureProof(page, "after-forget-reconnect.png");

    // Token-only reset: the browser device identity survives.
    const identityAfter = await page.evaluate(() =>
      localStorage.getItem("openclaw-device-identity-v1"),
    );
    expect(identityAfter).toBe(identityBefore);
  });

  it("forgetting in a token-bearing tab drops the shared credential too", async () => {
    // Review P1 regression: shared auth outranks stored device auth, so the
    // same tab that signed in with #token=… must not resume the old session.
    const context = await createContext();
    const open = gatewayPages(context);
    const { gateway, page } = await open(WILFRED_GATEWAY_URL, WILFRED_DEVICE_TOKEN, {
      sharedToken: "shared-wilfred",
    });
    const seededConnect = await gateway.waitForRequest("connect");
    expect(requireConnectAuth(seededConnect).token).toBe("shared-wilfred");
    await expect.poll(() => storedToken(page, WILFRED_GATEWAY_URL)).toBeDefined();

    const forgetRow = await openForgetDialog(page);
    await forgetRow.click();
    const confirmButton = page.getByRole("button", { name: "Forget", exact: true });
    await confirmButton.waitFor({ state: "visible" });
    await confirmButton.click();

    await expectForgotten(gateway);

    // The tab-scoped shared token is gone from session storage as well.
    const sessionToken = await page.evaluate(() => {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key?.includes("token") && sessionStorage.getItem(key)?.trim()) {
          return { key, present: true };
        }
      }
      return null;
    });
    expect(sessionToken).toBeNull();

    // Review P1 regression: loadSettings() restores the session-scoped shared
    // token on boot, so a reload after Forget must not sign the tab back in
    // with the forgotten shared credential. Drop the #token fragment first so
    // the reload exercises the storage path, not the URL sign-in path. The
    // device token is not asserted here: this mock grants one on any accepted
    // hello (including the post-forget reconnect), which a real token-auth
    // gateway rejecting the credential-free connect would never do.
    await page.evaluate(() => history.replaceState(null, "", location.href.split("#")[0]));
    await page.reload();
    const reloadConnect = await gateway.waitForRequest("connect");
    expect(readConnectAuth(reloadConnect)?.token).toBeUndefined();
  });
});
