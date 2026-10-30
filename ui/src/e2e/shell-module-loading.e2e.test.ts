import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
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

function trackDocuments(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      count += 1;
    }
  });
  return () => count;
}

function visibleHitTarget(element: Locator) {
  return element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return (
      box.top >= 0 &&
      box.bottom <= innerHeight &&
      node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    );
  });
}

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

  it("recovers a failed source shell import once and restores the same conversation draft", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { awaitInitialRoster: false });
      const documents = trackDocuments(page);
      const target = `${suite.server.baseUrl}chat/main`;
      await page.goto(target);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Keep this unsent draft through shell recovery.";
      await composer.fill(draft);

      const reachable = createDeferredCore();
      let probes = 0;
      await page.route("**/index.html", async (route) => {
        if (route.request().method() !== "HEAD") {
          await route.fallback();
          return;
        }
        probes += 1;
        await reachable.promise;
        await route.fallback();
      });
      await page.route(shellModule, (route) => route.abort("internetdisconnected"), { times: 1 });
      try {
        await page.reload();
        await page.locator(".lazy-view-error--stale").waitFor();
        await expect.poll(() => probes).toBe(1);
        expect(documents()).toBe(2);
        reachable.resolve();
        await expect.poll(() => composer.inputValue()).toBe(draft);
        await waitForControlUiRoute(page, { routeId: "chat" });
        expect(documents()).toBe(3);
        expect(page.url()).toBe(target);
        expect(await page.locator(".lazy-view-error").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      } finally {
        reachable.resolve();
      }
    });
  });

  it("keeps early typed input accessible when a failed shell cannot safely reload", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { awaitInitialRoster: false });
      const documents = trackDocuments(page);
      const failShell = createDeferredCore();
      await page.route(shellModule, async (route) => {
        if (documents() === 1) {
          await failShell.promise;
          await route.abort("internetdisconnected");
        } else {
          await route.fallback();
        }
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
        const boot = page.locator("#openclaw-boot-composer");
        const draft = "Keep my early input until I can recover it.";
        await boot.fill(draft);
        await boot.press("Enter");
        failShell.resolve();
        const error = page.locator(".lazy-view-error--stale");
        await error.waitFor();
        expect(await boot.isVisible()).toBe(true);
        expect(await boot.inputValue()).toBe(draft);
        expect(await boot.getAttribute("data-submit-queued")).toBe("");
        expect(await error.textContent()).toContain("Copy the draft below");
        const dragCalls = await page.evaluateHandle(() => {
          const calls: unknown[] = [];
          Object.assign(window, {
            webkit: {
              messageHandlers: {
                openclawWindowDrag: {
                  postMessage: (message: unknown) => {
                    calls.push(message);
                  },
                },
              },
            },
          });
          return calls;
        });
        await page.locator(".loading-skeleton__header").click();
        expect(await dragCalls.evaluate((calls) => calls.splice(0))).toEqual([
          { type: "window-drag" },
        ]);
        await error.locator("summary").click();
        await error.locator(".lazy-view-error__subtitle").click();
        expect(await dragCalls.jsonValue()).toEqual([]);
        await dragCalls.dispose();
        await page.setViewportSize({ width: 400, height: 360 });
        await expect.poll(() => visibleHitTarget(boot)).toBe(true);
        await boot.click();
        await expect.poll(() => visibleHitTarget(boot)).toBe(true);
        const recovery = error.getByRole("button", { name: "Reload", exact: true });
        await page.locator(".loading-skeleton__messages--interactive").hover();
        await page.mouse.wheel(0, 500);
        await expect.poll(() => visibleHitTarget(recovery)).toBe(true);
        expect(await visibleHitTarget(boot)).toBe(true);
        await recovery.click();
        await error.waitFor();
        expect(documents()).toBe(1);
        expect(await boot.inputValue()).toBe(draft);
        await expect
          .poll(() => boot.evaluate((node) => document.activeElement === node))
          .toBe(true);
        await boot.fill("");
        await error.getByRole("button", { name: "Reload", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat" });
        expect(documents()).toBe(2);
        expect(await page.locator("#openclaw-boot-composer").count()).toBe(0);
        expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      } finally {
        failShell.resolve();
      }
    });
  });

  it("leaves a shell evaluation error on its ordinary manual recovery surface", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const documents = trackDocuments(page);
      let probes = 0;
      page.on("request", (request) => {
        if (request.method() === "HEAD") {
          probes += 1;
        }
      });
      await page.route(shellModule, (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: 'throw new Error("Shell initialization failed");',
        }),
      );
      await installMockGateway(page, { awaitInitialRoster: false });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const error = page.locator(".lazy-view-error");
      await error.getByText("Panel failed to load", { exact: true }).waitFor();
      expect(await error.getByRole("button", { name: "Retry", exact: true }).isVisible()).toBe(
        true,
      );
      expect(await error.locator(".lazy-view-error__detail").textContent()).toContain(
        "Shell initialization failed",
      );
      expect(documents()).toBe(1);
      expect(probes).toBe(0);
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
          const documents = trackDocuments(page);
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
          const draft = "Keep this draft while the panel is unavailable.";
          const conversation = page.getByText("The conversation remains available.", {
            exact: true,
          });
          await composer.fill(draft);
          await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
          const failure = page.locator(".sidebar-region__right-runtime .lazy-view-error");
          await failure.getByText("Panel failed to load", { exact: true }).waitFor();
          expect(failedImports).toBe(1);
          const close = page.getByRole("button", { name: "Close Files", exact: true });
          expect(await close.count()).toBe(1);
          if (dirtyConfig) {
            await failure.getByRole("button", { name: "Retry", exact: true }).click();
            await page
              .getByText("Finish saving or discard pending config changes before reloading.", {
                exact: true,
              })
              .waitFor();
            expect(documents()).toBe(1);
          }
          await close.click();
          await expect.poll(() => failure.count()).toBe(0);
          expect(await composer.inputValue()).toBe(draft);
          expect(await conversation.isVisible()).toBe(true);
          expect(documents()).toBe(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (!dirtyConfig) {
            await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
            await failure.waitFor();
            await page.unroute(sidebarModule);
            await failure.getByRole("button", { name: "Retry", exact: true }).click();
            await page.locator('.sidebar-region [data-panel-slot="workspace"]').waitFor();
            expect(documents()).toBe(2);
            expect(await composer.inputValue()).toBe(draft);
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
