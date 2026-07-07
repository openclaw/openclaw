// Control UI tests cover browser-native device-token reuse in independent tabs.
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
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

  it("connects a new tab with the device token issued to an authenticated tab", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    openContexts.add(context);

    const sourcePage = await context.newPage();
    const sourceGateway = await installMockGateway(sourcePage);
    await sourcePage.goto(`${server.baseUrl}chat#token=shared`);
    const sourceConnect = await sourceGateway.waitForRequest("connect");
    expect(requireRecord(requireRecord(sourceConnect.params).auth).token).toBe("shared");
    await sourcePage.locator("openclaw-app-shell").waitFor();

    const targetPage = await context.newPage();
    const targetGateway = await installMockGateway(targetPage);
    await targetPage.goto(`${server.baseUrl}chat`);
    const targetConnect = await targetGateway.waitForRequest("connect");
    const targetAuth = requireRecord(requireRecord(targetConnect.params).auth);

    expect(targetAuth.token).toBe("e2e-device-token");
    expect(targetAuth.deviceToken).toBe("e2e-device-token");
    expect(await targetPage.locator("openclaw-login-gate").count()).toBe(0);
  });
});
