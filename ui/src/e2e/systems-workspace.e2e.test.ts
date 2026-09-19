import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Systems workspace mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

function installSystemsGateway(page: Page, additionalWorkers = 20) {
  return installMockGateway(page, {
    sessions: Array.from({ length: 30 }, (_, index) =>
      createControlUiSessionRow(`agent:main:task-${index}`, `Task ${index + 1}`, 30 - index),
    ),
    featureMethods: ["environments.list", "node.list", "system.info"],
    methodResponses: {
      "environments.list": {
        environments: [
          { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
          { id: "worker-one", type: "worker", label: "Cloud worker", status: "available" },
          ...Array.from({ length: additionalWorkers }, (_, index) => ({
            id: `worker-${index + 2}`,
            type: "worker",
            label: `Worker ${index + 2}`,
            status: "available",
          })),
          ...(["destroyed", "failed"] as const).map((state) => ({
            id: `worker-${state}`,
            type: "worker",
            label: `${state} worker history`,
            status: state === "destroyed" ? "unavailable" : "error",
            worker: {
              state,
              profileId: "cloud",
              providerId: "crabbox",
              ...(state === "destroyed" ? { leaseId: "released-lease" } : {}),
              ageMs: 1_000,
              attachedSessionIds: [],
              tunnelStatus: "stopped",
            },
          })),
        ],
      },
      "node.list": { nodes: [] },
      "system.info": {
        machineName: "Gateway machine",
        hostname: "gateway.test",
        platform: "linux",
        release: "test",
        arch: "x64",
        osLabel: "Linux",
        nodeVersion: "v26",
        pid: 1,
        uptimeMs: 1000,
        cpuCount: 4,
        loadAverage: [0.5, 0.4, 0.3],
        memoryTotalBytes: 8192,
        memoryFreeBytes: 4096,
      },
    },
  });
}

suite.define(() => {
  it.each(["dashboards", "systems"])(
    "scrolls navigation and the %s sidebar content together",
    async (route) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 900 },
        },
        async ({ page }) => {
          await installSystemsGateway(page);
          await page.goto(suite.server.baseUrl + route);
          const home = page.locator(".nav-item--home");
          const row = page
            .locator(route === "systems" ? ".systems-machine" : ".sidebar-recent-session")
            .first();
          await row.waitFor();
          if (route === "dashboards") {
            const showMore = page
              .locator("openclaw-app-sidebar")
              .getByRole("button", { name: "Show more" });
            await showMore.click();
            await showMore.click();
            await expect.poll(() => page.locator(".sidebar-recent-session").count()).toBe(30);
          }
          const homeTop = () => home.evaluate((element) => element.getBoundingClientRect().top);
          const rowTop = () => row.evaluate((element) => element.getBoundingClientRect().top);
          await home.hover();
          await row.hover();
          const initialHomeTop = await homeTop();
          const initialRowTop = await rowTop();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({ path: path.join(suite.artifactDir, `${route}-top.png`) });
          }
          await page.mouse.wheel(0, 160);
          await expect.poll(rowTop).toBeLessThan(initialRowTop - 80);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({ path: path.join(suite.artifactDir, `${route}-scrolled.png`) });
          }
          await expect
            .poll(
              async () => (await homeTop()) - initialHomeTop - ((await rowTop()) - initialRowTop),
            )
            .toBeCloseTo(0, 0);

          await page.mouse.wheel(0, -1000);
          await expect.poll(homeTop).toBeCloseTo(initialHomeTop, 0);
          await home.hover();
          await page.mouse.wheel(0, 120);
          await expect.poll(homeTop).toBeLessThan(initialHomeTop - 80);
          await expect
            .poll(
              async () => (await homeTop()) - initialHomeTop - ((await rowTop()) - initialRowTop),
            )
            .toBeCloseTo(0, 0);
        },
      );
    },
  );

  it("loads the lazy workspace and keeps its machine picker aligned after navigation", async () => {
    const artifacts = createControlUiE2eArtifactDir("systems-worker-history");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installSystemsGateway(page, 0);
    try {
      await page.goto(suite.server.baseUrl + "systems");
      await gateway.waitForRequest("environments.list");
      const inventory = page.locator(".systems-sidebar");
      await inventory.getByRole("button", { name: /Cloud worker/ }).click();
      await expect
        .poll(() => page.locator(".systems-heading h1").textContent())
        .toBe("Cloud worker");
      await page.screenshot({ path: path.join(artifacts, "machine-inventory.png") });
      expect(await inventory.getByRole("button", { name: /worker history/ }).count()).toBe(0);
      expect(await inventory.locator(".systems-group__count").allTextContents()).toEqual(["1"]);
      await page.locator('.sidebar-nav a[href$="/dashboards"]').click();
      await expect.poll(() => page.locator(".systems-sidebar").count()).toBe(0);
      await page.locator('.sidebar-nav a[href$="/systems"]').click();
      await expect
        .poll(() => page.locator(".systems-heading h1").textContent())
        .toBe("Cloud worker");
      await page.setViewportSize({ width: 640, height: 900 });
      const picker = page.locator(".systems-mobile-picker");
      await expect.poll(() => picker.isVisible()).toBe(true);
      expect(await picker.inputValue()).toBe("worker-one");
      expect(await picker.locator("option").allTextContents()).not.toEqual(
        expect.arrayContaining([expect.stringContaining("worker history")]),
      );
      expect(await page.locator("openclaw-systems-page").count()).toBe(1);
      await gateway.setMethodResponse("environments.list", {
        environments: [
          { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
          {
            id: "worker-one",
            type: "worker",
            label: "Cloud worker",
            status: "unavailable",
            worker: {
              state: "destroyed",
              profileId: "cloud",
              providerId: "crabbox",
              leaseId: "released-lease",
              ageMs: 2_000,
              attachedSessionIds: [],
              tunnelStatus: "stopped",
            },
          },
        ],
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await inventory.getByRole("button", { name: "Refresh machines" }).click();
      await expect.poll(() => inventory.locator(".systems-machine").count()).toBe(1);
      expect(await inventory.locator(".systems-group__count").allTextContents()).toEqual([]);
      await page.setViewportSize({ width: 640, height: 900 });
      expect(await picker.locator('option[value="worker-one"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
