import { chromium, firefox } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import {
  canRunPlaywrightChromium as canRunPlaywrightBrowser,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightBrowser(chromiumExecutablePath);
const describeControlUiE2e =
  chromiumAvailable || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
type CspRuntime = typeof globalThis & {
  __openclawCspEvalViolations?: number;
  __zod_globalConfig?: { jitless?: boolean };
};

const browsers = [
  { name: "Chromium", engine: chromium, executablePath: chromiumExecutablePath },
  { name: "Firefox", engine: firefox, executablePath: firefox.executablePath() },
].filter(
  ({ name, executablePath }) => name === "Chromium" || canRunPlaywrightBrowser(executablePath),
);

let server: ControlUiE2eServer;

describeControlUiE2e("Control UI strict CSP E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
  });

  afterAll(() => server?.close());

  it.each(browsers)("starts without probing eval in $name", async ({ engine, executablePath }) => {
    const browser = await engine.launch({ executablePath });
    try {
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.addInitScript(() => {
        const runtime = globalThis as CspRuntime;
        runtime["__openclawCspEvalViolations"] = 0;
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.blockedURI === "eval" && event.effectiveDirective.startsWith("script-src")) {
            runtime["__openclawCspEvalViolations"]!++;
          }
        });
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page);
      await page.route(server.baseUrl, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        await route.fulfill({
          body,
          headers: {
            ...response.headers(),
            "content-security-policy": buildControlUiCspHeader({
              inlineScriptHashes: computeInlineScriptHashes(body),
            }),
          },
          response,
        });
      });

      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);
      const csp = response?.headers()["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).not.toContain("'unsafe-eval'");
      await gateway.waitForRequest("connect");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 10_000 });

      const cspState = await page.evaluate(() => {
        const runtime = globalThis as CspRuntime;
        return {
          jitless: runtime["__zod_globalConfig"]?.jitless === true,
          evalViolations: runtime["__openclawCspEvalViolations"] ?? 0,
        };
      });
      expect(cspState).toEqual({ jitless: true, evalViolations: 0 });
    } finally {
      await browser.close();
    }
  });
});
