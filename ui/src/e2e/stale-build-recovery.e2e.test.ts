import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { closeContext } from "./login-gate-e2e.test-support.ts";

declare global {
  interface Window {
    recordWorkerRefresh: () => Promise<void>;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI stale-build recovery E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("retries a background import after an unchanged Gateway returns without replacing the document", async () => {
    const context = await suite.browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const refreshModule = controlUiE2eBuiltModuleRequest("ui/src/app/sw-refresh.runtime.ts");
    let reachable = true;
    let refreshes = 0;
    let documents = 0;
    await page.exposeFunction("recordWorkerRefresh", () => refreshes++);
    await page.addInitScript(() => {
      // The imported capability's update call proves it ran; foreground activity
      // tracking also reads registrations and cannot stand in for that proof.
      Object.defineProperty(navigator.serviceWorker, "getRegistration", {
        value: async () => ({
          installing: null,
          waiting: null,
          active: null,
          update: () => window.recordWorkerRefresh(),
        }),
      });
    });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents++;
      }
    });
    await page.route(refreshModule, (route) =>
      reachable ? route.fallback() : route.abort("connectionrefused"),
    );
    await page.route("**/index.html", (route) =>
      reachable ? route.fallback() : route.abort("connectionrefused"),
    );
    const gateway = await installMockGateway(page);
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Keep this draft through the restart");
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      reachable = false;
      await gateway.setOnline(false);
      const failedImport = page.waitForEvent("requestfailed", {
        predicate: (request) => refreshModule.test(request.url()),
      });
      const failedProbe = page.waitForEvent("requestfailed", {
        predicate: (request) => new URL(request.url()).pathname === "/index.html",
      });
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await Promise.all([failedImport, failedProbe]);
      expect(documents).toBe(1);
      reachable = true;
      await gateway.setOnline(true);
      // A retry must execute the deferred capability in the original document;
      // merely suppressing the reload would strand the failed background work.
      await expect
        .poll(() => (documents > 1 ? "reloaded" : refreshes > 0 ? "refreshed" : "waiting"))
        .toBe("refreshed");
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(await composer.inputValue()).toBe("Keep this draft through the restart");
      expect(documents).toBe(1);
    } finally {
      await closeContext(context);
    }
  });

  it("cache-busts stale-build recovery on a first dashboard navigation", async () => {
    const context = await suite.browser.newContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const documentRequests: Array<{ fresh: boolean; pathname: string }> = [];
    const appOrigin = new URL(suite.server.baseUrl).origin;
    await page.route(`${appOrigin}/**`, async (route) => {
      const request = route.request();
      if (request.resourceType() === "document") {
        const url = new URL(request.url());
        documentRequests.push({
          fresh: url.searchParams.has("openclaw_mount_recovery"),
          pathname: url.pathname,
        });
      }
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      sessionKey: "agent:example-agent:example-session",
    });
    const mismatch = {
      code: "UNAVAILABLE",
      message: "Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    };
    const target = new URL("dashboard/example-agent/example-session", suite.server.baseUrl);

    try {
      await page.goto(target.href);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);

      await expect.poll(() => documentRequests.length).toBe(2);
      await gateway.waitForRequest("connect");
      expect(documentRequests).toEqual([
        { fresh: false, pathname: target.pathname },
        { fresh: true, pathname: target.pathname },
      ]);
      await gateway.resolveDeferred("connect");

      await page.locator("openclaw-app-shell").waitFor();
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      await expect.poll(() => page.url()).toBe(target.href);
    } finally {
      await closeContext(context);
    }
  });

  it("preserves a new private draft while classifying a retired import", async () => {
    const context = await suite.browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const refreshModule = controlUiE2eBuiltModuleRequest("ui/src/app/sw-refresh.runtime.ts");
    let retired = false;
    let recoveries = 0;
    const releaseRecovery = Promise.withResolvers<void>();
    await page.route(refreshModule, (route) =>
      retired ? route.fulfill({ status: 404, body: "retired" }) : route.fallback(),
    );
    await page.route("**/index.html", async (route) => {
      if (route.request().headers()["x-openclaw-reachability-probe"] !== "1") {
        await route.fallback();
        return;
      }
      recoveries++;
      await releaseRecovery.promise;
      await route.fulfill({
        contentType: "text/html",
        body: '<script>globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO={"buildId":"replacement-test-build"};</script>',
      });
    });
    await installMockGateway(page);
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      retired = true;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(() => recoveries).toBeGreaterThanOrEqual(1);
      await page.getByRole("switch", { name: "Incognito", exact: true }).click();
      await composer.fill("Keep this draft until I choose to reload");
      releaseRecovery.resolve();
      // The response now identifies a new build, but the draft owns reload admission.
      await page.waitForTimeout(100);
      // The original failure and its retry may each start one classification.
      expect(recoveries).toBeLessThanOrEqual(2);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(await composer.inputValue()).toBe("Keep this draft until I choose to reload");
    } finally {
      releaseRecovery.resolve();
      await closeContext(context);
    }
  });
});
