import { cp, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { afterEach, expect, inject, it } from "vitest";
import { handleControlUiHttpRequest } from "../../../src/gateway/control-ui.ts";
import type { ControlUiRootState } from "../../../src/gateway/server-control-ui-root.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
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

it("reloads a stale document onto the current build when an unvisited lazy route is missing", async () => {
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
  // Keep unrelated old lazy assets available so only Activity triggers stale-build recovery.
  await cp(path.join(rootA, "assets"), path.join(rootB, "assets"), {
    recursive: true,
    force: false,
    filter: (source) => source !== path.join(rootA, "assets", activityAssetA),
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
    const context = await browser.newContext(createControlUiE2eContextOptions());
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
      expect(requests.some(({ url }) => url.includes(activityAssetA))).toBe(false);

      root = { kind: "bundled", path: rootB, realPath: await realpath(rootB) };
      await rm(rootA, { recursive: true, force: true });
      // Persist the server identity for the next document without reconnecting
      // the old one: only its first missing lazy chunk may trigger this reload.
      await gateway.setServerBuildId(buildB);
      const requestStart = requests.length;
      const documentReload = page.waitForEvent("domcontentloaded");
      await page.evaluate(() => {
        history.pushState(null, "", "/activity?view=live");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await documentReload;
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
      expect(documents).toHaveLength(2);
      const reloadUrl = new URL(documents[1]!);
      expect(reloadUrl.pathname).toBe("/activity");
      expect(reloadUrl.searchParams.get("view")).toBe("live");
      expect(reloadUrl.searchParams.get("openclaw_mount_recovery")).toMatch(/^\d+$/u);
      expect(await page.locator(".lazy-view-error").count()).toBe(0);
      expect(pageErrors.slice(postReloadErrors)).toEqual([]);
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
}, 180_000);
