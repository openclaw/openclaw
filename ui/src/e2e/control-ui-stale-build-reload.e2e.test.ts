import { readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { afterEach, expect, it } from "vitest";
import { handleControlUiHttpRequest } from "../../../src/gateway/control-ui.ts";
import type { ControlUiRootState } from "../../../src/gateway/server-control-ui-root.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  buildProductionControlUiE2e,
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
const buildA = "stale-reload-build-a";
const buildB = "stale-reload-build-b";
type BundledRoot = Extract<ControlUiRootState, { kind: "bundled" }>;

it("reloads a stale document onto the current build when an unvisited lazy route is missing", async () => {
  const fixture = tempDirs.make("openclaw-stale-build-reload-");
  const rootA = path.join(fixture, "build-a");
  const rootB = path.join(fixture, "build-b");
  // Real production chunks and routing exercise Vite's preload errors as well as
  // browser import rejection; a synthetic import cannot prove this recovery path.
  await buildProductionControlUiE2e(rootA, buildA);
  await buildProductionControlUiE2e(rootB, buildB);
  const activityAssetA = (await readdir(path.join(rootA, "assets"))).find((file) =>
    /^activity-page-.*\.js$/u.test(file),
  );
  if (!activityAssetA) {
    throw new Error("Production build did not emit the Activity lazy chunk");
  }
  expect(await readdir(path.join(rootB, "assets"))).not.toContain(activityAssetA);

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
      : await chromium.launch({
          executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
        });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
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
    try {
      const baseUrl = `http://127.0.0.1:${server.claim.port}/`;
      expect((await page.goto(`${baseUrl}new`))?.status()).toBe(200);
      await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
      await expect
        .poll(async () => (await gateway.getRequests("connect")).at(-1)?.params)
        .toMatchObject({ client: { buildId: buildA } });
      expect(requests.some(({ url }) => url.includes(activityAssetA))).toBe(false);
      expect(await page.locator("openclaw-activity-page").count()).toBe(0);
      expect(documents).toHaveLength(1);

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
      await page.locator("openclaw-activity-page").waitFor({ state: "visible" });
      await page.getByRole("region", { name: "Active sessions", exact: true }).waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("connect")).at(-1)?.params)
        .toMatchObject({ client: { buildId: buildB } });
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
      expect(
        await page
          .getByText(
            /Importing a module script failed|Failed to fetch dynamically imported module/iu,
          )
          .count(),
      ).toBe(0);
      expect(pageErrors.slice(postReloadErrors)).toEqual([]);
    } catch (error) {
      console.error(
        "Stale-build reload requests:",
        JSON.stringify({ requests, documents, pageErrors }),
      );
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
