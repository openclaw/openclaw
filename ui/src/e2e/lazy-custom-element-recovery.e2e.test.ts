import {
  buildControlUiFocusPath,
  type ControlUiFocusBuildTarget,
} from "@openclaw/session-url-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiE2eBuiltModuleRequest,
  controlUiE2eRouteStylesheetRequest,
  failControlUiModuleForDocuments,
} from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const nativeTitlebarModule = "ui/src/components/macos-titlebar-controls.runtime-solid.tsx";
const viewport = { height: 900, width: 1280 };
const pageOptions = { locale: "en-US", serviceWorkers: "block", viewport } as const;
const button = (host: Page | Locator, name: string) =>
  host.getByRole("button", { name, exact: true });
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

const suite = createControlUiE2eSuite({
  name: "Control UI lazy custom-element recovery",
});

function observeDocuments(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      count += 1;
    }
  });
  return () => count;
}

async function traceHeadFrames(page: Page, success: boolean) {
  await page.addInitScript((expectSuccess) => {
    const observed = window as Window & { completedHeadFrames?: number };
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (args[1]?.method === "HEAD" && (expectSuccess ? response.ok : response.status === 503)) {
        requestAnimationFrame(() => {
          observed.completedHeadFrames = (observed.completedHeadFrames ?? 0) + 1;
        });
      }
      return response;
    };
  }, success);
  return () =>
    page.evaluate(
      () => (window as Window & { completedHeadFrames?: number }).completedHeadFrames ?? 0,
    );
}

async function withHeldModule(
  page: Page,
  module: RegExp,
  run: (held: Awaited<ReturnType<typeof holdModuleResponse>>) => Promise<void>,
) {
  const held = await holdModuleResponse(page, module);
  try {
    await run(held);
  } finally {
    held.release();
  }
}

async function installChunkFailure(
  page: Page,
  modulePath: string,
  options: { manualProbe?: Promise<void>; automaticReload?: boolean } = {},
) {
  let headCount = 0;
  let recoveryProbeCount = 0;
  let documentAvailable = options.automaticReload === true;
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "HEAD") {
      await route.fallback();
      return;
    }
    headCount += 1;
    // Automatic recovery keeps probing while offline. Manual-retry cases own
    // an outage phase, not a single failed request.
    if (!documentAvailable) {
      await route.fulfill({ status: 503 });
      return;
    }
    recoveryProbeCount += 1;
    await options.manualProbe;
    await route.fallback();
  });
  const failure = await failControlUiModuleForDocuments(
    page,
    controlUiE2eBuiltModuleRequest(modulePath),
  );
  return {
    chunkDocumentCount: failure.documentCount,
    headCount: () => headCount,
    recoveryProbeCount: () => recoveryProbeCount,
    restoreDocument: () => {
      documentAvailable = true;
    },
  };
}

function focusPath(target: ControlUiFocusBuildTarget): string {
  const resolvedPath = buildControlUiFocusPath(target, "");
  if (!resolvedPath) {
    throw new Error(`Could not build focus path for ${target.kind}`);
  }
  return resolvedPath;
}

async function expectRealChunkFailure(page: Page, label: string) {
  const error = page.locator(".lazy-view-error");
  await error.waitFor();
  const text = await error.textContent();
  expect(text).toContain(label);
  expect(text).toContain("Failed to fetch dynamically imported module");
  await button(error, "Retry").waitFor();
  await button(error, "Close").waitFor();
  return error;
}

async function retryThroughReload(
  page: Page,
  error: ReturnType<Page["locator"]>,
  failure: Awaited<ReturnType<typeof installChunkFailure>>,
  action = "Retry",
): Promise<void> {
  const reloaded = page.waitForEvent("domcontentloaded");
  await button(error, action).click();
  // Admit recovery only after the user action: restoring before click lets
  // the automatic probe navigate away before Playwright dispatches it.
  failure.restoreDocument();
  await reloaded;
}

const focusedCases = [
  {
    name: "browser",
    label: "browser panel",
    path: focusPath({
      kind: "browser",
      sessionKey,
      tab: { target: "host", profile: "work", targetId: "existing" },
    }),
    modulePath: "ui/src/components/browser/browser-document.tsx",
    gateway: {
      featureMethods: ["browser.request"],
      operatorScopes: ["operator.read"],
    },
    ready: (page: Page) =>
      page
        .getByText(
          "Browser control is unavailable for this connection. Reconnect with browser access.",
        )
        .waitFor(),
  },
  {
    name: "terminal",
    label: "terminal panel",
    path: focusPath({ kind: "terminal" }),
    modulePath: "ui/src/components/terminal/terminal-panel-registration.tsx",
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
      terminalEnabled: true,
    },
    ready: (page: Page) => page.locator("openclaw-terminal-panel .tp-header").waitFor(),
  },
  {
    name: "desktop",
    label: "desktop panel",
    path: focusPath({ kind: "desktop", control: false }),
    modulePath: "ui/src/components/desktop/desktop-panel-solid.tsx",
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "desktop.observe", "environments.list"],
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
        },
      },
    },
    ready: (page: Page) => page.getByText("Desktop sources", { exact: true }).waitFor(),
  },
  {
    name: "dashboard",
    label: "dashboard document",
    path: focusPath({ kind: "dashboard", path: "/dashboard/main/12345678" }),
    modulePath: "ui/src/components/board/board-document.tsx",
    gateway: {
      sessionKey,
      featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
      methodResponses: {
        "sessions.resolve": {
          ok: true,
          key: sessionKey,
          agentId: "main",
          boardFace: "dashboard",
          displayName: "Lazy dashboard",
        },
        "sessions.describe": {
          session: {
            key: sessionKey,
            kind: "direct",
            boardFace: "dashboard",
            displayName: "Lazy dashboard",
            updatedAt: 1,
          },
        },
        "board.get": { sessionKey, revision: 1, tabs: [], widgets: [] },
      },
    },
    ready: (page: Page) => page.locator("openclaw-board-document openclaw-board-view").waitFor(),
  },
];

const systemBusyness = {
  name: "System busyness",
  label: "System busyness",
  tag: "openclaw-debug-overlay-content",
  modulePath: "ui/src/pages/debug/debug-overlay-content.ts",
  dock: undefined,
  frame: (page: Page) => page.locator(".debug-overlay"),
  close: (page: Page) =>
    page.locator(".debug-overlay__header").getByRole("button", { name: "Close", exact: true }),
  open: async (page: Page) => {
    await page.locator(".sidebar-identity-card").click();
    await page.locator('.sidebar-identity-menu [data-value="command:debug-overlay"]').click();
  },
  ready: (page: Page) =>
    page
      .locator('openclaw-debug-overlay-content .debug-overlay__section[aria-busy="false"]')
      .first(),
};

const dockedCases = [
  ...(["right", "bottom"] as const).map((dock) => ({
    name: `Home ${dock}`,
    label: "Assistant sidebar",
    tag: "openclaw-assistant-panel-content",
    modulePath: "ui/src/components/assistant-panel-content-solid.tsx",
    dock,
    frame: (page: Page) => page.locator(".assistant-panel"),
    close: (page: Page) => button(page, "Close assistant sidebar"),
    open: async (page: Page) => {
      await page.locator(".sidebar-footer-bar__home").click();
    },
    ready: (page: Page) =>
      page.locator("openclaw-assistant-panel .agent-chat__composer-combobox textarea"),
  })),
  systemBusyness,
  {
    ...systemBusyness,
    name: "System busyness frame",
    tag: "openclaw-debug-overlay",
    modulePath: "ui/src/pages/debug/debug-overlay.tsx",
  },
];

async function installDockedScenario(
  page: Page,
  dock?: "right" | "bottom",
  route: "chat" | "new" = "chat",
) {
  if (dock) {
    await page.addInitScript((side) => {
      const key = "openclaw.custodian.panel.v1";
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({ open: false, dock: side, height: 360, width: 520 }),
        );
      }
    }, dock);
  }
  const workKey = "agent:main:loading-proof";
  await installMockGateway(page, {
    sessionKey: workKey,
    sessions: [workKey, "agent:main:main"].map((key) => ({
      key,
      kind: "direct",
      label: key === workKey ? "Workspace" : "Home",
      updatedAt: 1,
    })),
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    historyMessages: [{ role: "assistant", content: "The workspace is ready." }],
    methodResponses: {
      "diagnostics.lanes": {
        lanes: [
          {
            lane: "main",
            queuedCount: 0,
            activeCount: 0,
            maxConcurrent: 16,
            draining: false,
            generation: 1,
          },
        ],
        dynamic: null,
      },
    },
  });
  await page.goto(
    route === "new"
      ? `${suite.server.baseUrl}new`
      : controlUiSessionUrl(suite.server.baseUrl, workKey),
  );
  await waitForControlUiGatewayReady(page);
  const composer = page.locator(
    route === "new"
      ? ".new-session-page__message"
      : "openclaw-chat-page .agent-chat__composer-combobox textarea",
  );
  await composer.fill("Keep working");
  return composer;
}

suite.define(() => {
  it("recovers the login gate after its chunk fails without loading it during admission", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const failure = await installChunkFailure(page, "ui/src/components/login-gate-solid.tsx");
      const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
      const rejectLogin = async () => {
        await gateway.waitForRequest("connect");
        await gateway.rejectDeferred("connect", {
          code: "INVALID_REQUEST",
          message: "token missing",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
        });
      };
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await page.locator(".connect-splash").waitFor();
      expect(failure.chunkDocumentCount()).toBe(0);
      await rejectLogin();
      const error = page.locator(".lazy-view-error");
      await error.waitFor();
      expect(await error.textContent()).toContain("Failed to fetch dynamically imported module");
      expect(failure.chunkDocumentCount()).toBe(1);
      await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);
      await retryThroughReload(page, error, failure, "Reload");
      await rejectLogin();
      await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();
      expect(failure.chunkDocumentCount()).toBe(2);
      expect(await error.count()).toBe(0);
      const connectCount = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await button(page, "Connect").click();
      await gateway.waitForRequest("connect", { after: connectCount });
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    });
  });

  it("does not reload after a lazy surface is dismissed during its retry probe", async () => {
    let releaseProbe = () => {};
    const manualProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    try {
      await suite.withPage(pageOptions, async ({ page }) => {
        await page.clock.install();
        const completedHeadFrames = await traceHeadFrames(page, true);
        const failure = await installChunkFailure(page, "ui/src/components/command-palette.tsx", {
          manualProbe,
        });
        await installMockGateway(page);
        const documentRequests = observeDocuments(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await page.keyboard.press("ControlOrMeta+k");
        const error = await expectRealChunkFailure(page, "command palette");
        await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);

        const reloaded = new Promise<void>((resolve) => {
          page.once("domcontentloaded", () => resolve());
        });
        await button(error, "Retry").click();
        failure.restoreDocument();
        await expect.poll(failure.recoveryProbeCount).toBeGreaterThanOrEqual(1);
        await page.keyboard.press("Escape");
        const paletteModal = page.locator('openclaw-modal-dialog[label="command palette"]');
        await expect.poll(() => paletteModal.count()).toBe(0);
        releaseProbe();
        await expect
          .poll(async () => documentRequests() > 1 || (await completedHeadFrames()) >= 1)
          .toBe(true);
        // A generic automatic retry used to wake one second after this
        // first settled frame. Close must remain authoritative beyond it.
        await page.clock.runFor(1_500);
        if (documentRequests() > 1) {
          await reloaded;
        }
        await waitForControlUiGatewayReady(page);
        expect(documentRequests()).toBe(1);
        expect(await paletteModal.count()).toBe(0);
        expect(await page.evaluate(() => sessionStorage.getItem("openclaw:lazy-event"))).toBeNull();
      });
    } finally {
      releaseProbe();
    }
  });

  for (const testCase of focusedCases) {
    it(`reloads the focused ${testCase.name} after its real hashed chunk fails`, async () => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const failure = await installChunkFailure(page, testCase.modulePath);
        await installMockGateway(page, testCase.gateway);
        const documentRequests = observeDocuments(page);

        expect((await page.goto(new URL(testCase.path, suite.server.baseUrl).href))?.status()).toBe(
          200,
        );
        const error = await expectRealChunkFailure(page, testCase.label);
        const failedPathname = new URL(page.url()).pathname;
        expect(failure.chunkDocumentCount()).toBe(1);
        await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);
        expect(documentRequests()).toBe(1);

        await retryThroughReload(page, error, failure);
        await testCase.ready(page);

        await expect.poll(failure.chunkDocumentCount).toBe(2);
        expect(new URL(page.url()).pathname).toBe(failedPathname);
        expect(documentRequests()).toBe(2);
      });
    });
  }

  it("restores the command-palette action after a real stale-chunk reload", async () => {
    const context = await suite.newBrowserContext(pageOptions);
    try {
      const page = await context.newPage();
      const failure = await installChunkFailure(page, "ui/src/components/command-palette.tsx");
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
      });
      const error = await expectRealChunkFailure(page, "command palette");
      await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);
      expect(failure.chunkDocumentCount()).toBe(1);

      await retryThroughReload(page, error, failure);
      await page
        .locator("openclaw-command-palette")
        .getByRole("textbox", { name: "Search or start a task…" })
        .waitFor();

      await expect.poll(failure.chunkDocumentCount).toBe(2);
      expect(await page.locator("openclaw-command-palette").count()).toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["new", "chat"] as const)(
    "keeps the outer System busyness frame nonmodal and transfers its current mode on %s",
    async (route) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        await withHeldModule(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/debug/debug-overlay.tsx"),
          async (held) => {
            const composer = await installDockedScenario(page, undefined, route);
            expect(
              await page.evaluate(() => customElements.get("openclaw-debug-overlay") === undefined),
            ).toBe(true);
            expect(held.requests()).toBe(0);
            await systemBusyness.open(page);
            await held.request;
            const frame = page.locator(".debug-overlay");
            await frame.waitFor();
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
            const handle = (await frame.locator("header").boundingBox())!;
            await page.mouse.move(handle.x + 30, handle.y + 20);
            await page.mouse.down();
            await page.mouse.move(handle.x - 30, handle.y, { steps: 3 });
            await page.mouse.up();
            const expanded = await frame.boundingBox();
            await composer.fill("Still editable during the outer load");
            await button(frame, "Minimize system busyness").click();
            await expect
              .poll(() => frame.getAttribute("class"))
              .toContain("debug-overlay--minimized");
            await frame.evaluate(async (element) => {
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
              await Promise.all(element.getAnimations().map((animation) => animation.finished));
            });
            const minimized = await frame.boundingBox();
            expect(minimized).not.toBeNull();
            expect(minimized!.height).toBeLessThan(expanded!.height);
            await composer.press("Escape");
            expect(await frame.isVisible()).toBe(true);
            await button(frame, "Expand system busyness").click();
            await expect.poll(() => frame.boundingBox()).toEqual(expanded);
            await button(frame, "Minimize system busyness").click();
            held.release();
            await page.locator("openclaw-debug-overlay .debug-overlay--minimized").waitFor();
            await expect.poll(() => frame.boundingBox()).toEqual(minimized);
            expect(await composer.inputValue()).toBe("Still editable during the outer load");
            await button(frame, "Expand system busyness").click();
            await systemBusyness.ready(page).waitFor();
            await expect.poll(() => frame.boundingBox()).toEqual(expanded);
            await button(frame, "Minimize system busyness").click();
            await button(frame, "Close").press("Escape");
            await frame.waitFor({ state: "hidden" });
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
          },
        );
      });
    },
  );

  it("keeps Home header controls aligned on a cold New session while its body loads", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      // Home preloads Chat styles before importing its body. Delay that dependency
      // so a warm stylesheet cannot conceal missing eager frame styles.
      await withHeldModule(
        page,
        controlUiE2eRouteStylesheetRequest("chat", "new"),
        async (held) => {
          const composer = await installDockedScenario(page, "right", "new");
          await page.locator(".sidebar-footer-bar__home").click();
          await held.request;
          const header = page.locator(".assistant-panel-header");
          const headerBounds = await header.boundingBox();
          const titleBounds = await header.locator(".assistant-panel-title").boundingBox();
          expect(headerBounds?.height).toBe(48);
          expect(titleBounds).not.toBeNull();
          for (const control of await header.locator(".assistant-panel-actions button").all()) {
            const bounds = await control.boundingBox();
            expect(bounds).toMatchObject({ width: 28, height: 28 });
            expect(bounds!.x).toBeGreaterThanOrEqual(titleBounds!.x + titleBounds!.width);
            expect(bounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
              headerBounds!.y + headerBounds!.height,
            );
          }
          await composer.fill("Keep working while Home loads");
          await button(page, "Close assistant sidebar").click();
          await page.locator(".assistant-panel").waitFor({ state: "hidden" });
          expect(await composer.inputValue()).toBe("Keep working while Home loads");
        },
      );
    });
  });

  it.each(dockedCases)(
    "loads $name in place and keeps dismissal authoritative",
    async (testCase) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        await withHeldModule(
          page,
          controlUiE2eBuiltModuleRequest(testCase.modulePath),
          async (held) => {
            const composer = await installDockedScenario(page, testCase.dock);
            expect(held.requests()).toBe(0);
            await testCase.open(page);
            await held.request;
            const frame = testCase.frame(page);
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
            await frame.getByRole("status", { name: "Loading…", exact: true }).first().waitFor();
            expect(await frame.getAttribute("aria-label")).toBe(testCase.label);
            const loadingBounds = await frame.boundingBox();
            expect(loadingBounds).not.toBeNull();
            if (testCase.dock) {
              expect(loadingBounds?.[testCase.dock === "right" ? "width" : "height"]).toBe(
                testCase.dock === "right" ? 520 : 360,
              );
              await expect
                .poll(async () => {
                  const bounds = await composer.boundingBox();
                  if (!bounds || !loadingBounds) {
                    return false;
                  }
                  return testCase.dock === "right"
                    ? bounds.x + bounds.width <= loadingBounds.x + 1
                    : bounds.y + bounds.height <= loadingBounds.y + 1;
                })
                .toBe(true);
            }
            expect(await composer.inputValue()).toBe("Keep working");
            await composer.click({ position: { x: 8, y: 8 } });
            await composer.press("ControlOrMeta+a");
            await page.keyboard.type("Keep working while the panel loads");
            expect(await composer.inputValue()).toBe("Keep working while the panel loads");
            await testCase.close(page).click();
            await frame.waitFor({ state: "hidden" });

            held.release();
            await page.evaluate(
              (tag) => customElements.whenDefined(tag).then(() => undefined),
              testCase.tag,
            );
            expect(await frame.isVisible()).toBe(false);
            expect(await testCase.ready(page).isVisible()).toBe(false);
            await testCase.open(page);
            await testCase.ready(page).waitFor();
            await expect.poll(() => frame.boundingBox()).toEqual(loadingBounds);
            expect(await composer.inputValue()).toBe("Keep working while the panel loads");
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
          },
        );
      });
    },
  );

  it.each(
    dockedCases
      .filter((testCase) => testCase.dock !== "bottom")
      .flatMap((testCase) =>
        (testCase.dock ? [false] : [false, true]).map((automaticReload) =>
          Object.assign({}, testCase, {
            automaticReload,
            recovery: automaticReload ? "automatic reload" : "manual Retry",
          }),
        ),
      ),
  )("recovers $name from its in-place stale-chunk error via $recovery", async (testCase) => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const failure = await installChunkFailure(page, testCase.modulePath, {
        automaticReload: testCase.automaticReload,
      });
      const composer = await installDockedScenario(page, testCase.dock);
      const automaticReload = testCase.automaticReload
        ? page.waitForEvent("domcontentloaded")
        : undefined;
      await testCase.open(page);
      const frame = testCase.frame(page);
      const error = frame.locator(".lazy-view-error");
      if (automaticReload) {
        await automaticReload;
        await waitForControlUiGatewayReady(page);
      } else {
        await error.waitFor();
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        expect(await error.textContent()).toContain(testCase.label);
        expect(await error.textContent()).toContain("Failed to fetch dynamically imported module");
        expect(await testCase.close(page).isVisible()).toBe(true);
        await composer.click({ position: { x: 8, y: 8 } });
        expect(await composer.inputValue()).toBe("Keep working");
        await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);

        await retryThroughReload(page, error, failure);
      }
      await testCase.ready(page).waitFor();
      expect(failure.chunkDocumentCount()).toBe(2);
      expect(await page.locator(".lazy-view-error, openclaw-modal-dialog").count()).toBe(0);
      expect(await composer.inputValue()).toBe("Keep working");
      if (!testCase.dock) {
        await page.reload();
        await waitForControlUiGatewayReady(page);
        expect(await frame.isVisible()).toBe(false);
        expect(await composer.inputValue()).toBe("Keep working");
      }
    });
  });

  it("keeps native titlebar state and actions current while its chunk is loading", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await installNativeWebChrome(page);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await withHeldModule(
        page,
        controlUiE2eBuiltModuleRequest(nativeTitlebarModule),
        async (held) => {
          const response = await page.goto(suite.server.baseUrl, { waitUntil: "domcontentloaded" });
          expect(response?.status()).toBe(200);
          await page.locator(".sidebar-rail").waitFor({ state: "attached" });
          await held.request;
          const element = page.locator("openclaw-macos-titlebar-controls");
          expect(await element.count()).toBe(0);
          expect(
            await page.evaluate(
              () => customElements.get("openclaw-macos-titlebar-controls") === undefined,
            ),
          ).toBe(true);
          await page.evaluate(() => {
            window.dispatchEvent(
              new CustomEvent("openclaw:native-history-state", {
                detail: { canGoBack: true, canGoForward: false },
              }),
            );
            window.dispatchEvent(new CustomEvent("openclaw:native-toggle-sidebar"));
          });
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .toContain("shell--nav-collapsed");

          held.release();
          const toolbar = page.locator(".macos-titlebar-controls");
          await toolbar.waitFor({ state: "visible" });
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Back" }).isDisabled())
            .toBe(false);
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Forward" }).isDisabled())
            .toBe(true);
          await page.locator(".sidebar-rail__create a, .sidebar-rail__create button").click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(held.requests()).toBe(1);
          expect(errors).toEqual([]);
        },
      );
    });
  });

  it("recovers the native titlebar visibly after its chunk fails", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.clock.install();
      const completedHeadFrames = await traceHeadFrames(page, false);
      await installNativeWebChrome(page);
      const failure = await installChunkFailure(page, nativeTitlebarModule);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      });
      const documentRequests = observeDocuments(page);
      const response = await page.goto(suite.server.baseUrl, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(200);
      await page.locator(".sidebar-rail").waitFor({ state: "attached" });
      const error = await expectRealChunkFailure(page, "openclaw-macos-titlebar-controls");
      await expect.poll(failure.headCount).toBeGreaterThanOrEqual(1);
      expect(failure.chunkDocumentCount()).toBe(1);
      await expect.poll(completedHeadFrames).toBeGreaterThanOrEqual(1);
      await pauseVirtualClock(page);
      const failedProbes = await completedHeadFrames();
      // Cross the recovery owner's maximum backoff so another real HEAD
      // fails while the error and its dismissal action remain available.
      await page.clock.runFor(15_001);
      await expect
        .poll(async () => {
          await page.clock.runFor(17);
          return completedHeadFrames();
        })
        .toBeGreaterThan(failedProbes);
      expect(documentRequests()).toBe(1);
      await button(error, "Close").waitFor();

      await page.clock.resume();
      await retryThroughReload(page, error, failure);
      const toolbar = page.locator(".macos-titlebar-controls");
      await toolbar.waitFor({ state: "visible" });
      await page.locator(".sidebar-session-toolbar__collapse").click();
      await page.locator(".sidebar-rail__create a, .sidebar-rail__create button").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(await error.count()).toBe(0);
      expect(failure.chunkDocumentCount()).toBe(2);
      expect(documentRequests()).toBe(2);
    });
  });
});
