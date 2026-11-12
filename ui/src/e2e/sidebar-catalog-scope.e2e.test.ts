import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar catalog scope" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("keeps background catalog reads quiet while navigation is hidden and catches up once on reopen", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        methodResponses: { "sessions.catalog.list": { catalogs: [] } },
      });
      const reads = () => gateway.getRequests("sessions.catalog.list", { limitPerHost: 40 });
      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiRoute(page, { routeId: "new-session" });
      const navigation = page.locator(".sidebar-shell");
      const toggle = page.locator('[data-navigation-view="sessions"]');
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await expect.poll(async () => (await reads()).length).toBe(1);
      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(false);
      await pauseVirtualClock(page);
      await page.clock.fastForward(125_001);
      await page.clock.resume();
      expect(await reads()).toHaveLength(1);

      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await pauseVirtualClock(page);
      await page.clock.fastForward(5_001);
      await page.clock.resume();
      await expect.poll(async () => (await reads()).length).toBe(2);
      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(false);
      await pauseVirtualClock(page);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.fastForward(125_001);
      await page.clock.resume();
      expect(await reads()).toHaveLength(2);

      await toggle.click();
      await expect.poll(() => navigation.isVisible()).toBe(true);
      await pauseVirtualClock(page);
      await page.clock.fastForward(5_001);
      await page.clock.resume();
      await expect.poll(async () => (await reads()).length).toBe(3);
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });

  it("discovers and opens ordinary guest sessions without requesting the external catalog", async () => {
    const artifactDir = captureUiProof
      ? createControlUiE2eArtifactDir("sidebar-catalog-scope")
      : undefined;
    const viewport = { width: 1440, height: 900 };
    const context = await suite.newBrowserContext({
      viewport,
      ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    try {
      const key = "agent:main:visitor-notes";
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.write"],
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        sessions: [createControlUiSessionRow(key, "Visitor notes", Date.now())],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Welcome back." }] },
        ],
        methodResponses: {
          "sessions.catalog.list": {
            __mockError: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const session = sidebar.locator(`[data-session-key="${key}"]`).first();
      await session.waitFor({ state: "visible" });
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "sidebar.png") });
      }
      expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(0);
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await session.click();
      await page.getByText("Welcome back.", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "opened-session.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
