import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, inject, it, vi } from "vitest";
import type { ControlUiRootState } from "../../../src/gateway/server-control-ui-root.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { buildProductionControlUiE2e, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const startup = vi.hoisted(() => ({ starting: true }));

// mock-isolation: Loading this unused test harness is the regression; no exports are consumed.
vi.mock("../../../src/gateway/server-http.test-harness.ts", () => {
  throw new Error("Fresh HTTP fixture loaded the unnecessary full Gateway test harness");
});

vi.mock("../../../src/gateway/control-ui.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/gateway/control-ui.ts")>();
  if (!startup.starting) {
    throw new Error(
      "The Control UI HTTP owner must initialize before this fixture declares startup complete",
    );
  }
  return actual;
});

const runtime = createDeferred();
let requests = 0;
// This suite exercises the asset-free fallback, not the preferred Web UI lane.
const controlUiRoot: ControlUiRootState = { kind: "missing" };
let currentUiRoot = "";
const suite = createControlUiE2eSuite({
  name: "Fresh browser at the production Gateway HTTP boundary",
  startServerBeforeBrowser: true,
  browserLaunchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
  async startServer() {
    const productionRoot = inject("controlUiE2ePrebuiltAssets")?.root;
    if (productionRoot) {
      // The deployment lane owns immutable production-relative assets.
      currentUiRoot = productionRoot;
    } else {
      await mkdir(path.resolve(".openclaw/tmp"), { recursive: true });
      currentUiRoot = await mkdtemp(path.resolve(".openclaw/tmp/fallback-current-ui-"));
      await buildProductionControlUiE2e(currentUiRoot, "fallback-current-source");
    }
    const { createOpenClawTestState } =
      await import("../../../src/test-utils/openclaw-test-state.ts");
    const state = await createOpenClawTestState({
      prefix: "fresh-browser-maintenance-",
      scenario: "minimal",
      applyEnv: true,
      prepareProfileCatalog: true,
    });
    let http: typeof import("../../../src/gateway/server-http.ts");
    let configRuntime: typeof import("../../../src/config/runtime-snapshot.ts");
    try {
      [http, configRuntime] = await Promise.all([
        import("../../../src/gateway/server-http.ts"),
        import("../../../src/config/runtime-snapshot.ts"),
      ]);
    } catch (error) {
      await state.cleanup();
      throw error;
    }
    const config = { gateway: { trustedProxies: [] } };
    const ready = createDeferred<{ baseUrl: string; close: () => Promise<void> }>();
    const done = createDeferred();
    const lifetime = runQaGatewayFixture(
      async () => {
        await state.writeConfig(config);
        configRuntime.setRuntimeConfigSnapshot(config, config);
        // A ready fixture must not spend browser recovery deadlines initializing its HTTP owner.
        const { getControlUiModule } = await import("../../../src/gateway/server-http-modules.ts");
        await getControlUiModule();
        const server = http.createGatewayHttpServer({
          clients: new Set(),
          handleHooksRequest: async () => false,
          resolvedAuth: { mode: "none", allowTailscale: false },
          getRuntimeConfig: () => config,
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          controlUiEnabled: true,
          controlUiBasePath: "/console",
          controlUiRoot,
          getStartup: () =>
            startup.starting
              ? { ok: false, status: "starting", uptimeMs: 1, pendingReason: "startup-sidecars" }
              : { ok: true, status: "started", uptimeMs: 2 },
          waitForRequestRuntime: () => runtime.promise,
        });
        try {
          server.prependListener("request", (request) => {
            if (request.headers.accept?.includes("text/html")) {
              requests++;
            }
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Missing HTTP fixture port");
          }
          ready.resolve({
            baseUrl: "http://127.0.0.1:" + address.port + "/console/",
            async close() {
              done.resolve();
              await lifetime;
            },
          });
          await done.promise;
        } finally {
          runtime.resolve();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      () => state.cleanup(),
      () =>
        productionRoot ? Promise.resolve() : rm(currentUiRoot, { recursive: true, force: true }),
    );
    void lifetime.catch(ready.reject);
    return ready.promise;
  },
});

suite.define(() => {
  it("resumes automatic recovery after back-forward navigation", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const target = suite.server.baseUrl + "new?restore=retained#draft";
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.goto(new URL("/healthz", target).href, { waitUntil: "domcontentloaded" });
        await page.goBack({ waitUntil: "commit" });
        expect(page.url()).toBe(target);
        await page.getByRole("heading", { name: "OpenClaw is starting", exact: true }).waitFor();
        // Exercise the browser's actual restoration choice, not synthetic pageshow dispatch.
        expect(await page.getByRole("button").count()).toBe(0);
        const before = requests;
        await expect.poll(() => requests).toBeGreaterThan(before);
      },
    );
  });

  it("shows startup before app bytes and automatically returns to the same route", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const baseUrl = suite.server.baseUrl;
        await page.clock.install();
        await pauseVirtualClock(page);
        const target = baseUrl + "new?view=retained#draft";
        const navigation = page
          .goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => null);
        try {
          await expect.poll(() => requests).toBeGreaterThan(0);
          const title = page.getByRole("heading", { name: "OpenClaw is starting", exact: true });
          const visible = await title.waitFor({ state: "visible", timeout: 3_000 }).then(
            () => true,
            () => false,
          );
          if (visible && process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const frame = await takeControlUiScreenshotFrame(page, page.locator("main"), [title], {
              animations: "disabled",
            });
            await writeFile(path.join(suite.artifactDir, "fresh-startup-desktop.png"), frame.png);
            const mobile = await takeControlUiScreenshotFrame(page, page.locator("main"), [title], {
              animations: "disabled",
              viewport: { width: 390, height: 844 },
            });
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await writeFile(path.join(suite.artifactDir, "fresh-startup-mobile.png"), mobile.png);
          }
          expect(visible, "fresh document must not wait for request-runtime materialization").toBe(
            true,
          );
          await navigation;
          expect(page.url()).toBe(target);
          await page.clock.resume();
          const beforeRetry = requests;
          expect(await page.getByRole("button").count()).toBe(0);
          await expect.poll(() => requests).toBeGreaterThan(beforeRetry);
          expect(page.url()).toBe(target);
          Object.assign(controlUiRoot, { kind: "resolved", path: currentUiRoot });
          startup.starting = false;
          runtime.resolve();
          await expect
            .poll(() => page.locator("#openclaw-maintenance").count(), { timeout: 20_000 })
            .toBe(0);
          expect(page.url()).toBe(target);
        } finally {
          startup.starting = false;
          runtime.resolve();
          await page.clock.resume();
          await navigation;
        }
      },
    );
  });

  it("does not call an unknown app-bundle failure an update or restart", async () => {
    Object.assign(controlUiRoot, { kind: "resolved", path: currentUiRoot });
    startup.starting = false;
    runtime.resolve();
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const baseUrl = suite.server.baseUrl;
        await page.addInitScript(() => {
          addEventListener(
            "openclaw-control-ui-rendered",
            () => {
              document.documentElement.dataset.proofRendered = "yes";
            },
            { once: true },
          );
        });
        let failAssets = true;
        await page.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const asset = url.pathname.includes("/assets/") && url.pathname.endsWith(".js");
          // Model an unknown outage after the first real document: no usable bundle or HTTP retry.
          const retry =
            !request.isNavigationRequest() && url.pathname === new URL(baseUrl).pathname;
          await (failAssets && (asset || retry) ? route.abort("failed") : route.continue());
        });
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        const title = page.getByRole("heading", { name: "Control UI didn’t start", exact: true });
        await expect.poll(() => title.isVisible(), { timeout: 15_000 }).toBe(true);
        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("#openclaw-mount-fallback"),
            [title],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, "fresh-unknown-failure-desktop.png"),
            frame.png,
          );
        }
        expect(await page.locator("#openclaw-mount-fallback-summary").textContent()).not.toMatch(
          /restart|updat/i,
        );
        expect(await page.getByRole("button").count()).toBe(0);
        failAssets = false;
        await expect
          .poll(() => page.locator("#openclaw-mount-fallback").isVisible(), { timeout: 30_000 })
          .toBe(false);
        await expect
          .poll(() => page.locator("html").getAttribute("data-proof-rendered"), { timeout: 30_000 })
          .toBe("yes");
      },
    );
  });
});
