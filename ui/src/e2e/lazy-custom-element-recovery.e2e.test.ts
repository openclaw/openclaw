import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildControlUiFocusPath,
  type ControlUiFocusBuildTarget,
} from "@openclaw/session-url-contract";
import type { Page, Route, Video } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

let artifactDir: string;
beforeEach(() => {
  if (captureUiProof) {
    artifactDir = createControlUiE2eArtifactDir("lazy-custom-element-recovery");
  }
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const railProofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let railProofDir: string | undefined;
beforeEach(() => {
  railProofDir = railProofDirParent
    ? createControlUiE2eArtifactDir("lazy-custom-element-recovery", railProofDirParent)
    : undefined;
});
const nativeTitlebarChunk = /\/assets\/macos-titlebar-controls\.runtime-[^/?]+\.js(?:\?.*)?$/u;
const viewport = { height: 900, width: 1280 };
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

const suite = createControlUiE2eSuite({
  name: "Control UI lazy custom-element recovery",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

async function installChunkFailure(
  page: Page,
  chunk: RegExp,
  options: { manualProbe?: Promise<void>; automaticReload?: boolean } = {},
) {
  let headCount = 0;
  let chunkRequestCount = 0;
  let failedChunkUrl: string | undefined;
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "HEAD") {
      await route.fallback();
      return;
    }
    headCount += 1;
    if (headCount === 1 && !options.automaticReload) {
      await route.fulfill({ status: 503 });
      return;
    }
    await options.manualProbe;
    await route.fallback();
  });
  await page.route(chunk, async (route: Route) => {
    // A shared module can have both a facade and implementation matching the
    // prefix. Count retries of the injected failure, not its other dependencies.
    failedChunkUrl ??= route.request().url();
    if (route.request().url() !== failedChunkUrl) {
      await route.fallback();
      return;
    }
    chunkRequestCount += 1;
    if (chunkRequestCount === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fallback();
  });
  return { chunkRequestCount: () => chunkRequestCount, headCount: () => headCount };
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
  await error.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await error.getByRole("button", { name: "Close", exact: true }).waitFor();
  return error;
}

async function retryThroughReload(page: Page, error: ReturnType<Page["locator"]>): Promise<void> {
  const reloaded = page.waitForEvent("domcontentloaded");
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await reloaded;
}

const focusedCases = [
  {
    name: "terminal",
    label: "terminal panel",
    path: focusPath({ kind: "terminal" }),
    chunk: /\/assets\/terminal-panel-registration-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "lazy-terminal-e2e",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    },
    ready: (page: Page) => page.locator("openclaw-terminal-panel .tp-header").waitFor(),
  },
  {
    name: "desktop",
    label: "desktop panel",
    path: focusPath({ kind: "desktop", control: false }),
    chunk: /\/assets\/desktop-panel-[^/?]+\.js(?:\?.*)?$/u,
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
    chunk: /\/assets\/board-document-[^/?]+\.js(?:\?.*)?$/u,
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
  chunk: /\/assets\/debug-overlay-content-[^/?]+\.js(?:\?.*)?$/u,
  proofName: "system-busyness",
  dock: undefined,
  frame: (page: Page) => page.locator(".debug-overlay"),
  close: (page: Page) =>
    page.locator(".debug-overlay__header").getByRole("button", { name: "Close", exact: true }),
  open: async (page: Page) => {
    await page.locator(".sidebar-identity-card").click();
    await page
      .locator('wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:debug-overlay"]')
      .click();
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
    chunk: /\/assets\/assistant-panel-content-[^/?]+\.js(?:\?.*)?$/u,
    proofName: `home-${dock}`,
    dock,
    frame: (page: Page) => page.locator(".assistant-panel"),
    close: (page: Page) =>
      page.getByRole("button", { name: "Close assistant sidebar", exact: true }),
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
    chunk: /\/assets\/debug-overlay-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
    proofName: "system-busyness-frame",
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
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const failure = await installChunkFailure(
          page,
          /\/assets\/login-gate-[^/?]+\.js(?:\?.*)?$/u,
        );
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
        expect(failure.chunkRequestCount()).toBe(0);
        await rejectLogin();
        const error = page.locator(".lazy-view-error");
        await error.waitFor();
        expect(await error.textContent()).toContain("Failed to fetch dynamically imported module");
        expect(failure.chunkRequestCount()).toBe(1);
        await expect.poll(failure.headCount).toBe(1);
        await Promise.all([
          page.waitForEvent("domcontentloaded"),
          error.getByRole("button", { name: "Reload", exact: true }).click(),
        ]);
        await rejectLogin();
        await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();
        expect(failure.chunkRequestCount()).toBe(2);
        expect(await error.count()).toBe(0);
        const connectCount = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await gateway.waitForRequest("connect", { after: connectCount });
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      },
    );
  });

  it("does not reload after a lazy surface is dismissed during its retry probe", async () => {
    let releaseProbe = () => {};
    const manualProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    try {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          await page.addInitScript(() => {
            const observed = window as Window & { completedHeadFrames?: number };
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
              const response = await originalFetch(...args);
              if (args[1]?.method === "HEAD") {
                // Observe the frame after the real fetch and its reload promise chain settle.
                requestAnimationFrame(() => {
                  observed.completedHeadFrames = (observed.completedHeadFrames ?? 0) + 1;
                });
              }
              return response;
            };
          });
          const failure = await installChunkFailure(
            page,
            /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
            { manualProbe },
          );
          await installMockGateway(page);
          let documentRequests = 0;
          page.on("request", (request) => {
            if (request.resourceType() === "document") {
              documentRequests += 1;
            }
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiGatewayReady(page);
          await page.keyboard.press("ControlOrMeta+k");
          const error = await expectRealChunkFailure(page, "command palette");
          await expect.poll(failure.headCount).toBe(1);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, "dismissed-retry-before.png") });
          }

          const reloaded = new Promise<void>((resolve) => {
            page.once("domcontentloaded", () => resolve());
          });
          await error.getByRole("button", { name: "Retry", exact: true }).click();
          await expect.poll(failure.headCount).toBe(2);
          await page.keyboard.press("Escape");
          const paletteModal = page.locator('openclaw-modal-dialog[label="command palette"]');
          await expect.poll(() => paletteModal.count()).toBe(0);
          releaseProbe();
          await expect
            .poll(
              async () =>
                documentRequests > 1 ||
                (await page.evaluate(
                  () =>
                    (window as Window & { completedHeadFrames?: number }).completedHeadFrames ?? 0,
                )) >= 2,
            )
            .toBe(true);
          // A generic automatic retry used to wake one second after this
          // first settled frame. Close must remain authoritative beyond it.
          await page.waitForTimeout(1_500);
          if (documentRequests > 1) {
            await reloaded;
          }
          await waitForControlUiGatewayReady(page);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, "dismissed-retry-after.png") });
          }
          console.info("LAZY_RETRY_DISMISSED", {
            documentRequests,
            headCount: failure.headCount(),
          });
          expect(documentRequests).toBe(1);
          expect(await paletteModal.count()).toBe(0);
          expect(
            await page.evaluate(() => sessionStorage.getItem("openclaw:lazy-event")),
          ).toBeNull();
        },
      );
    } finally {
      releaseProbe();
    }
  });

  for (const testCase of focusedCases) {
    it(`reloads the focused ${testCase.name} after its real hashed chunk fails`, async () => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const failure = await installChunkFailure(page, testCase.chunk);
          await installMockGateway(page, testCase.gateway);
          let documentRequests = 0;
          page.on("request", (request) => {
            if (request.resourceType() === "document") {
              documentRequests += 1;
            }
          });

          expect(
            (await page.goto(new URL(testCase.path, suite.server.baseUrl).href))?.status(),
          ).toBe(200);
          const error = await expectRealChunkFailure(page, testCase.label);
          const failedPathname = new URL(page.url()).pathname;
          expect(failure.chunkRequestCount()).toBe(1);
          await expect.poll(failure.headCount).toBe(1);
          expect(documentRequests).toBe(1);

          await retryThroughReload(page, error);
          await testCase.ready(page);

          await expect.poll(failure.chunkRequestCount).toBe(2);
          expect(new URL(page.url()).pathname).toBe(failedPathname);
          expect(documentRequests).toBe(2);
        },
      );
    });
  }

  it("restores the command-palette action after a real stale-chunk reload", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureUiProof ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    let video: Video | null = null;
    try {
      const page = await context.newPage();
      if (captureUiProof) {
        video = page.video();
      }
      const failure = await installChunkFailure(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
      });
      const error = await expectRealChunkFailure(page, "command palette");
      await expect.poll(failure.headCount).toBe(1);
      expect(failure.chunkRequestCount()).toBe(1);
      if (captureUiProof) {
        await writeFile(
          path.join(artifactDir, "failure.png"),
          await takeControlUiViewportScreenshot(page, error, [
            error.getByRole("button", { name: "Retry", exact: true }),
          ]),
        );
      }

      await retryThroughReload(page, error);
      await page
        .locator("openclaw-command-palette")
        .getByRole("textbox", { name: "Search or start a task…" })
        .waitFor();

      await expect.poll(failure.chunkRequestCount).toBe(2);
      expect(await page.locator("openclaw-command-palette").count()).toBe(1);
      if (captureUiProof) {
        await writeFile(
          path.join(artifactDir, "recovered.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".cmd-palette"), [
            page
              .locator("openclaw-command-palette")
              .getByRole("textbox", { name: "Search or start a task…" }),
          ]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (captureUiProof && video) {
        await video.saveAs(path.join(artifactDir, "recovery.webm"));
      }
    }
  });

  it.each(["new", "chat"] as const)(
    "keeps the outer System busyness frame nonmodal and transfers its current mode on %s",
    async (route) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const held = await holdModuleResponse(
            page,
            /\/assets\/debug-overlay-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
          );
          try {
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
            const expanded = await frame.boundingBox();
            expect(expanded).not.toBeNull();
            await composer.fill("Still editable during the outer load");
            await frame
              .getByRole("button", { name: "Minimize system busyness", exact: true })
              .click();
            await expect
              .poll(() => frame.getAttribute("class"))
              .toContain("debug-overlay--minimized");
            const minimized = await frame.boundingBox();
            expect(minimized).not.toBeNull();
            expect(minimized!.height).toBeLessThan(expanded!.height);
            await composer.press("Escape");
            expect(await frame.isVisible()).toBe(true);
            await frame
              .getByRole("button", { name: "Expand system busyness", exact: true })
              .click();
            await expect.poll(() => frame.boundingBox()).toEqual(expanded);
            await frame
              .getByRole("button", { name: "Minimize system busyness", exact: true })
              .click();
            if (captureUiProof) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(artifactDir, `system-busyness-${route}-outer-loading.png`),
              });
            }
            held.release();
            await page.locator("openclaw-debug-overlay .debug-overlay--minimized").waitFor();
            await expect.poll(() => frame.boundingBox()).toEqual(minimized);
            expect(await composer.inputValue()).toBe("Still editable during the outer load");
            await frame
              .getByRole("button", { name: "Expand system busyness", exact: true })
              .click();
            await systemBusyness.ready(page).waitFor();
            await expect.poll(() => frame.boundingBox()).toEqual(expanded);
            if (captureUiProof) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(artifactDir, `system-busyness-${route}-outer-ready.png`),
              });
            }
            await frame
              .getByRole("button", { name: "Minimize system busyness", exact: true })
              .click();
            await frame.getByRole("button", { name: "Close", exact: true }).press("Escape");
            await frame.waitFor({ state: "hidden" });
            expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
          } finally {
            held.release();
          }
        },
      );
    },
  );

  it("keeps Home header controls aligned on a cold New session while its body loads", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        // Home preloads Chat styles before importing its body. Delay that dependency
        // so a warm stylesheet cannot conceal missing eager frame styles.
        const held = await holdModuleResponse(
          page,
          /\/assets\/control-ui-boot-chat-[^/?]+\.css(?:\?.*)?$/u,
        );
        try {
          const composer = await installDockedScenario(page, "right", "new");
          await page.locator(".sidebar-footer-bar__home").click();
          await held.request;
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, "home-new-loading.png"),
            });
          }
          const header = page.locator(".assistant-panel-header");
          const headerBounds = await header.boundingBox();
          const titleBounds = await header.locator(".assistant-panel-title").boundingBox();
          expect(headerBounds?.height).toBe(48);
          expect(titleBounds).not.toBeNull();
          for (const control of await header.locator(".assistant-panel-actions button").all()) {
            const bounds = await control.boundingBox();
            expect(bounds?.width).toBe(28);
            expect(bounds?.height).toBe(28);
            expect(bounds!.x).toBeGreaterThanOrEqual(titleBounds!.x + titleBounds!.width);
            expect(bounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
              headerBounds!.y + headerBounds!.height,
            );
          }
          await composer.fill("Keep working while Home loads");
          await page.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
          await page.locator(".assistant-panel").waitFor({ state: "hidden" });
          expect(await composer.inputValue()).toBe("Keep working while Home loads");
        } finally {
          held.release();
        }
      },
    );
  });

  it.each(dockedCases)(
    "loads $name in place and keeps dismissal authoritative",
    async (testCase) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const held = await holdModuleResponse(page, testCase.chunk);
          try {
            const composer = await installDockedScenario(page, testCase.dock);
            expect(held.requests()).toBe(0);
            await testCase.open(page);
            await held.request;
            if (captureUiProof) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(artifactDir, `${testCase.proofName}-loading.png`),
              });
            }
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
            if (captureUiProof) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(artifactDir, `${testCase.proofName}-ready.png`),
              });
            }
          } finally {
            held.release();
          }
        },
      );
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
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport },
      async ({ page }) => {
        const failure = await installChunkFailure(page, testCase.chunk, {
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
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `${testCase.proofName}-error.png`),
            });
          }
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
          expect(await error.textContent()).toContain(testCase.label);
          expect(await error.textContent()).toContain(
            "Failed to fetch dynamically imported module",
          );
          expect(await testCase.close(page).isVisible()).toBe(true);
          await composer.click({ position: { x: 8, y: 8 } });
          expect(await composer.inputValue()).toBe("Keep working");
          await expect.poll(failure.headCount).toBe(1);

          await retryThroughReload(page, error);
        }
        await testCase.ready(page).waitFor();
        expect(failure.chunkRequestCount()).toBe(2);
        expect(await page.locator(".lazy-view-error, openclaw-modal-dialog").count()).toBe(0);
        expect(await composer.inputValue()).toBe("Keep working");
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${testCase.proofName}-recovered.png`),
          });
        }
        if (!testCase.dock) {
          await page.reload();
          await waitForControlUiGatewayReady(page);
          expect(await frame.isVisible()).toBe(false);
          expect(await composer.inputValue()).toBe("Keep working");
        }
      },
    );
  });

  it("keeps native titlebar state and actions current while its chunk is loading", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(railProofDir ? { recordVideo: { dir: railProofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        await installNativeWebChrome(page);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const held = await holdModuleResponse(page, nativeTitlebarChunk);
        try {
          const response = await page.goto(suite.server.baseUrl, { waitUntil: "domcontentloaded" });
          expect(response?.status()).toBe(200);
          await page.locator(".sidebar-brand").waitFor({ state: "attached" });
          await held.request;
          const element = page.locator("openclaw-macos-titlebar-controls");
          expect(await element.evaluate((node) => node.matches(":defined"))).toBe(false);
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
          if (railProofDir) {
            await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loading.png") });
          }

          held.release();
          const toolbar = page.locator(".macos-titlebar-controls");
          await toolbar.waitFor({ state: "visible" });
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Back" }).isDisabled())
            .toBe(false);
          await expect
            .poll(() => toolbar.getByRole("button", { name: "Forward" }).isDisabled())
            .toBe(true);
          await toolbar.getByRole("button", { name: "New session", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(held.requests()).toBe(1);
          expect(errors).toEqual([]);
          if (railProofDir) {
            await page.screenshot({ path: path.join(railProofDir, "native-titlebar-loaded.png") });
          }
        } finally {
          held.release();
        }
      },
    );
  });

  it.each([
    {
      name: "native titlebar",
      chunk: nativeTitlebarChunk,
      label: "openclaw-macos-titlebar-controls",
      webChrome: true,
      pathname: "",
      readySelector: ".sidebar-brand",
      preserveCollapsedNavigation: false,
      proofName: "native-titlebar",
    },
    {
      name: "floating sidebar attention",
      chunk: /\/assets\/sidebar-attention-[A-Za-z0-9_-]{8}\.js(?:\?.*)?$/u,
      label: "sidebar-attention",
      webChrome: false,
      pathname: "chat/main?nav=collapsed",
      readySelector: ".shell--nav-collapsed",
      preserveCollapsedNavigation: true,
      proofName: "sidebar-attention",
    },
  ])("recovers $name visibly after its chunk fails", async (testCase) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(railProofDir ? { recordVideo: { dir: railProofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        if (testCase.webChrome) {
          await installNativeWebChrome(page);
        }
        if (testCase.preserveCollapsedNavigation) {
          // Bootstrap consumes this one-shot intent; seed each recovered document
          // before its router can canonicalize the URL during the retry probe.
          await page.addInitScript(() => {
            const url = new URL(window.location.href);
            url.searchParams.set("nav", "collapsed");
            window.history.replaceState(window.history.state, "", url);
          });
        }
        const failure = await installChunkFailure(page, testCase.chunk);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        });
        const response = await page.goto(`${suite.server.baseUrl}${testCase.pathname}`, {
          waitUntil: "domcontentloaded",
        });
        expect(response?.status()).toBe(200);
        await page.locator(testCase.readySelector).waitFor({ state: "attached" });
        const error = await expectRealChunkFailure(page, testCase.label);
        await expect.poll(failure.headCount).toBe(1);
        expect(failure.chunkRequestCount()).toBe(1);
        if (railProofDir) {
          await page.screenshot({
            path: path.join(railProofDir, `${testCase.proofName}-failed.png`),
          });
        }

        await retryThroughReload(page, error);
        if (testCase.webChrome) {
          const toolbar = page.locator(".macos-titlebar-controls");
          await toolbar.waitFor({ state: "visible" });
          await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
          await toolbar.getByRole("button", { name: "New session", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        } else {
          await page.locator(".sidebar-attention--floating .sidebar-issues-button").click();
          await page.locator("#sidebar-issues-panel").waitFor({ state: "visible" });
        }
        expect(await error.count()).toBe(0);
        expect(failure.chunkRequestCount()).toBe(2);
        if (railProofDir) {
          await page.screenshot({
            path: path.join(railProofDir, `${testCase.proofName}-recovered.png`),
          });
        }
      },
    );
  });
});
