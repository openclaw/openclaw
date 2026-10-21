import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it("hands the boot skeleton to the pending route without a blank shell", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const held = await holdModuleResponse(page, /\/src\/pages\/chat\/route-entry\.ts(?:\?.*)?$/u);
      await installMockGateway(page, { awaitInitialRoster: false });
      try {
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await held.request;
        await page.locator(".shell").waitFor();
        expect(await page.locator("openclaw-router-outlet .loading-skeleton").count()).toBe(1);
        expect(await page.locator(".connect-splash").count()).toBe(0);

        held.release();
        await waitForControlUiRoute(page, { routeId: "chat" });
        expect(await page.locator("openclaw-chat-page").count()).toBe(1);
        expect(await page.locator("openclaw-router-outlet .lazy-view-state--loading").count()).toBe(
          0,
        );
      } finally {
        held.release();
      }
    });
  });

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

  it.each([false, true])(
    "dismisses a failed sidebar import without losing chat or bypassing unsaved work (dirty config: %s)",
    async (dirtyConfig) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const sidebarModule = "**/src/pages/chat/components/chat-sidebar-region.runtime.tsx*";
          let failedImports = 0;
          let documents = 0;
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
              documents += 1;
            }
          });
          await page.route(sidebarModule, async (route) => {
            failedImports += 1;
            await route.fulfill({
              contentType: "application/javascript",
              body: 'throw new SyntaxError("Synthetic sidebar module export failure");',
            });
          });
          const gateway = await installMockGateway(page, {
            historyMessages: [
              { role: "assistant", content: "The conversation remains available." },
              { role: "assistant", content: "[Recovery file](notes.txt)" },
            ],
            methodResponses: {
              "sessions.files.get": {
                sessionKey: "agent:main:main",
                root: "/workspace",
                file: {
                  path: "notes.txt",
                  name: "notes.txt",
                  kind: "read",
                  previewKind: "text",
                  contentEncoding: "utf8",
                  content: "The file remains available after recovery.",
                  missing: false,
                },
              },
            },
          });
          if (dirtyConfig) {
            await page.goto(suite.server.baseUrl + "settings/advanced");
            await page.getByRole("button", { name: "Raw", exact: true }).click();
            await page
              .locator(".config-raw-field textarea")
              .fill('{ logging: { level: "debug" } }');
            await page.evaluate(() =>
              window.openclawControlUi?.navigate("chat", { pathname: "/chat/main" }),
            );
          } else {
            await page.goto(suite.server.baseUrl + "chat/main");
          }
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("Keep this draft while the panel is unavailable.");
          await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
          const failure = page.locator(".sidebar-region__right-runtime .lazy-view-error");
          await failure.getByText("Panel failed to load", { exact: true }).waitFor();
          expect(failedImports).toBe(1);
          if (!dirtyConfig && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-chat-page"),
              [failure, composer],
              { animations: "disabled" },
            );
            const screenshot = path.join(suite.artifactDir, "failed-sidebar.png");
            await writeFile(screenshot, frame.png);
            console.info("Failed sidebar proof:", screenshot);
          }
          const close = page.getByRole("button", { name: "Close Files", exact: true });
          expect(await close.count()).toBe(1);
          if (dirtyConfig) {
            await failure.getByRole("button", { name: "Retry", exact: true }).click();
            await page
              .getByText("Finish saving or discard pending config changes before reloading.", {
                exact: true,
              })
              .waitFor();
            expect(documents).toBe(1);
          }
          await close.click();
          await expect.poll(() => failure.count()).toBe(0);
          expect(await composer.inputValue()).toBe(
            "Keep this draft while the panel is unavailable.",
          );
          expect(
            await page
              .getByText("The conversation remains available.", { exact: true })
              .isVisible(),
          ).toBe(true);
          expect(documents).toBe(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (!dirtyConfig) {
            await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
            await failure.waitFor();
            await page.unroute(sidebarModule);
            await failure.getByRole("button", { name: "Retry", exact: true }).click();
            await page.locator('.sidebar-region [data-panel-slot="workspace"]').waitFor();
            expect(documents).toBe(2);
            expect(await composer.inputValue()).toBe(
              "Keep this draft while the panel is unavailable.",
            );
            await page.getByRole("button", { name: "Close Files", exact: true }).click();
            expect(await page.locator(".sidebar-region--open").count()).toBe(0);
          }
        },
      );
    },
  );

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
