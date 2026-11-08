import { cp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { afterEach, expect, inject, it } from "vitest";
import { handleControlUiHttpRequest } from "../../../src/gateway/control-ui.ts";
import type { ControlUiRootState } from "../../../src/gateway/server-control-ui-root.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  buildProductionControlUiE2e,
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
const { executablePath: chromiumExecutablePath, wsEndpoint: chromiumWsEndpoint } =
  inject("controlUiE2eChromium");
const buildA = "stale-reload-build-a";
const buildB = "stale-reload-build-b";
type BundledRoot = Extract<ControlUiRootState, { kind: "bundled" }>;

it.each([false, true])(
  "reloads retired lazy assets without losing unsaved work (dirty config: %s)",
  async (dirtyConfig) => {
    const fixture = tempDirs.make("openclaw-stale-build-reload-");
    const rootA = path.join(fixture, "build-a");
    const rootB = path.join(fixture, "build-b");
    // An older chunk layout retires a real lazy import; build identity alone preserves asset hashes.
    await buildProductionControlUiE2e(rootA, buildA, { includeBootGroups: false });
    await buildProductionControlUiE2e(rootB, buildB);
    const activityModuleA = controlUiE2eBuiltModuleRequest(
      "ui/src/pages/activity/activity-route.tsx",
      rootA,
    );
    const activityAssetA = (await readdir(path.join(rootA, "assets"))).find((file) =>
      activityModuleA.test(`/assets/${file}`),
    );
    if (!activityAssetA) {
      throw new Error("Production build did not emit the Activity lazy chunk");
    }
    const toastModuleA = controlUiE2eBuiltModuleRequest("ui/src/lib/toast-view.tsx", rootA);
    // Keep unrelated old lazy assets available so only Activity triggers stale-build recovery.
    await cp(path.join(rootA, "assets"), path.join(rootB, "assets"), {
      recursive: true,
      force: false,
      filter: (source) =>
        source !== path.join(rootA, "assets", activityAssetA) &&
        (!dirtyConfig || !toastModuleA.test(`/assets/${path.basename(source)}`)),
    });

    let root: BundledRoot = { kind: "bundled", path: rootA, realPath: await realpath(rootA) };
    const requests: Array<{ method: string; url: string; status: number }> = [];
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          response.once("finish", () => {
            requests.push({
              method: request.method ?? "GET",
              url: request.url ?? "/",
              status: response.statusCode,
            });
          });
          // Match the mock bootstrap policy so CSP reconciliation does not reload.
          void handleControlUiHttpRequest(request, response, { root, terminalEnabled: false }).then(
            (handled) => {
              if (!handled && !response.writableEnded) {
                response.statusCode = 404;
                response.end("Not Found");
              }
            },
          );
        }),
    });
    let browser: Browser | undefined;
    try {
      browser = useWebKit
        ? await webkit.launch()
        : chromiumWsEndpoint
          ? await chromium.connect(chromiumWsEndpoint, { timeout: 30_000 })
          : await chromium.launch({ executablePath: chromiumExecutablePath });
      const context = await browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
      const documents: string[] = [];
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          documents.push(request.url());
        }
      });
      const gateway = await installMockGateway(page, { serverBuildId: buildA });
      const expectBuild = (id: string) =>
        expect
          .poll(async () => (await gateway.getRequests("connect")).at(-1)?.params)
          .toMatchObject({ client: { buildId: id } });
      try {
        const baseUrl = `http://127.0.0.1:${server.claim.port}/`;
        expect((await page.goto(`${baseUrl}new`))?.status()).toBe(200);
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        await expectBuild(buildA);
        if (dirtyConfig) {
          await page.goto(`${baseUrl}settings/advanced`);
          await page.getByRole("button", { name: "Raw", exact: true }).click();
          await page.locator(".config-raw-field textarea").fill('{ "count": 2 }');
          await expect
            .poll(() =>
              evaluateControlUiContext(page, (app) => app.runtimeConfig.state.configFormDirty),
            )
            .toBe(true);
        }
        const initialDocuments = documents.length;
        expect(requests.some(({ url }) => url.includes(activityAssetA))).toBe(false);

        root = { kind: "bundled", path: rootB, realPath: await realpath(rootB) };
        await rm(rootA, { recursive: true, force: true });
        // Persist the server identity for the next document without reconnecting
        // the old one: only its first missing lazy chunk may trigger this reload.
        await gateway.setServerBuildId(buildB);
        const requestStart = requests.length;
        let explanation: string | null = null;
        await page.evaluate(() => {
          history.pushState(null, "", "/activity?view=live");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        if (dirtyConfig) {
          const failure = page.locator(".lazy-view-error--stale");
          await failure.getByRole("button", { name: "Reload", exact: true }).click();
          const toast = page.locator("openclaw-toast-host [role=alert]");
          await toast.waitFor();
          await toast.hover();
          expect(documents).toHaveLength(initialDocuments);
          expect(
            await evaluateControlUiContext(page, (app) => ({
              dirty: app.runtimeConfig.state.configFormDirty,
              raw: app.runtimeConfig.state.configRaw,
            })),
          ).toEqual({ dirty: true, raw: '{ "count": 2 }' });
          expect(
            requests
              .slice(requestStart)
              .some(({ url, status }) => toastModuleA.test(url) && status === 404),
          ).toBe(true);
          explanation = await toast.textContent();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const directory = createControlUiE2eArtifactDir("retired-toast-reload");
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-app"),
              [toast, failure],
              { elements: [toast], animations: "disabled" },
            );
            await writeFile(path.join(directory, "blocked-reload.png"), frame.png);
          }
          await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
          await evaluateControlUiContext(page, (app) => app.runtimeConfig.discardDraft());
          expect(documents).toHaveLength(initialDocuments);
          await failure.getByRole("button", { name: "Reload", exact: true }).click();
        }
        const postReloadErrors = pageErrors.length;
        await waitForControlUiRoute(page, {
          routeId: "activity",
          pathname: "/activity",
          search: "?view=live",
        });
        await page.getByRole("region", { name: "Active sessions", exact: true }).waitFor();
        await expectBuild(buildB);
        expect(requests.slice(requestStart)).toContainEqual({
          method: "GET",
          url: `/assets/${activityAssetA}`,
          status: 404,
        });
        expect(documents).toHaveLength(initialDocuments + 1);
        const reloadUrl = new URL(documents.at(-1)!);
        expect(reloadUrl.pathname).toBe("/activity");
        expect(reloadUrl.searchParams.get("view")).toBe("live");
        expect(reloadUrl.searchParams.get("openclaw_mount_recovery")).toMatch(/^\d+$/u);
        expect(await page.locator(".lazy-view-error").count()).toBe(0);
        expect(pageErrors.slice(postReloadErrors)).toEqual([]);
        if (dirtyConfig) {
          expect(explanation).toContain(
            "Finish saving or discard pending config changes before reloading.",
          );
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
        }
      } catch (error) {
        if (error instanceof Error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error,
            label: `stale-build-reload-${useWebKit ? "webkit" : "chromium"}`,
            pageErrors,
          });
        }
        throw error;
      } finally {
        await context.close();
      }
    } finally {
      await browser?.close();
      await server.releaseListener();
      await server.claim.release();
    }
  },
  180_000,
);
