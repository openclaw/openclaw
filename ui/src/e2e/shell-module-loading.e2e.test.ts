import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI shell module loading",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const shellModule = /\/src\/app\/app-host\.tsx(?:\?.*)?$/u;

suite.define(() => {
  it("keeps the connecting presentation until the shell module can commit", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const held = await holdModuleResponse(page, shellModule);
      const gateway = await installMockGateway(page, { awaitInitialRoster: false });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await held.request;
        await gateway.waitForRequest("connect");
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
        );
        await page.locator(".connect-splash").waitFor();
        expect(await page.locator("openclaw-app-shell").count()).toBe(0);
        expect(await page.evaluate(() => window.openclawControlUi?.snapshot().ready)).toBe(false);

        held.release();
        await waitForControlUiRoute(page, { routeId: "new-session" });
        expect(await page.locator("openclaw-app-shell").count()).toBe(1);
        expect(await page.locator(".connect-splash").count()).toBe(0);
        expect(held.requests()).toBe(1);
      } finally {
        held.release();
      }
    });
  });

  it("reloads into the real shell after its failed import becomes reachable", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let failedImports = 0;
      let documents = 0;
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          documents += 1;
        }
      });
      await page.route(shellModule, async (route) => {
        failedImports += 1;
        await route.abort("failed");
      });
      await installMockGateway(page, { awaitInitialRoster: false });
      await page.goto(`${suite.server.baseUrl}new`);
      const failure = page.locator(".lazy-view-error--stale[role=alert]");
      await failure.waitFor();
      expect(failedImports).toBe(1);
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      await expect
        .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().ready))
        .toBe(false);
      const reload = failure.getByRole("button", { name: "Reload", exact: true });
      expect(await reload.isEnabled()).toBe(true);

      await page.unroute(shellModule);
      await reload.click();
      await waitForControlUiRoute(page, { routeId: "new-session" });
      expect(await page.locator("openclaw-app-shell").count()).toBe(1);
      expect(await failure.count()).toBe(0);
      expect(documents).toBe(2);
    });
  });

  it.each(["login", "focus"] as const)("does not acquire the shell for %s", async (mode) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const shellRequests: string[] = [];
      page.on("request", (request) => {
        if (shellModule.test(request.url())) {
          shellRequests.push(request.url());
        }
      });
      const gateway = await installMockGateway(page, {
        awaitInitialRoster: false,
        terminalEnabled: false,
        ...(mode === "login" ? { deferredMethods: ["connect"] } : {}),
      });
      await page.goto(`${suite.server.baseUrl}${mode === "focus" ? "focus/terminal" : "new"}`);
      await gateway.waitForRequest("connect");
      if (mode === "login") {
        await gateway.rejectDeferred("connect", {
          code: "INVALID_REQUEST",
          message: "token missing",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
        });
        await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();
      } else {
        await page.locator(".terminal-view-unavailable").waitFor();
      }
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(shellRequests).toEqual([]);
    });
  });
});
