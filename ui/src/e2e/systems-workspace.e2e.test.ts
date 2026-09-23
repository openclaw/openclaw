import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

function installSystemsGateway(
  page: Page,
  additionalWorkers = 20,
  methodResponses: Record<string, unknown> = {},
) {
  return installMockGateway(page, {
    sessions: Array.from({ length: 30 }, (_, index) =>
      createControlUiSessionRow(`agent:main:task-${index}`, `Task ${index + 1}`, 30 - index),
    ),
    featureMethods: [
      "environments.list",
      "node.list",
      "system.info",
      "config.get",
      "config.patch",
      "desktop.observe",
    ],
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
      ...methodResponses,
    },
  });
}

suite.define(() => {
  it("names Macs consistently and enables a discovered desktop without reconnecting", async () => {
    const artifacts = createControlUiE2eArtifactDir("systems-platform-labels");
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const originalConfig = {
          desktop: { host: { port: 5910, passwordFile: "/synthetic/vnc-password" } },
        };
        const gateway = await installSystemsGateway(page, 0, {
          "environments.list": {
            environments: [
              {
                id: "gateway",
                type: "local",
                label: "Gateway Mac",
                platform: "darwin",
                status: "available",
                desktopSetup: { state: "ready" },
              },
              {
                id: "node:mac",
                type: "node",
                label: "Paired Mac",
                platform: "macOS 27.0.0",
                status: "available",
              },
            ],
          },
          "system.info": {
            machineName: "Gateway Mac",
            hostname: "gateway.test",
            platform: "darwin",
            release: "26.0.0",
            arch: "arm64",
            osLabel: "macOS 27.0.0",
            nodeVersion: "v26",
            pid: 1,
            uptimeMs: 1000,
            cpuCount: 8,
            loadAverage: [0.5, 0.4, 0.3],
            memoryTotalBytes: 16 * 1024 ** 3,
            memoryFreeBytes: 8 * 1024 ** 3,
          },
          "config.get": {
            config: originalConfig,
            raw: JSON.stringify(originalConfig),
            hash: "desktop-config-0",
            valid: true,
            issues: [],
          },
        });
        await page.goto(suite.server.baseUrl + "systems");
        const inventory = page.locator(".systems-sidebar");
        await inventory.getByRole("button", { name: /Gateway Mac/ }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "systems-platforms.png") });
        expect(await inventory.locator(".systems-machine__meta").allTextContents()).toEqual([
          "macOS 27.0.0",
          "macOS 27.0.0",
        ]);
        expect(await page.locator(".systems-state").textContent()).toContain(
          "Screen Sharing is available",
        );
        expect((await gateway.getRequests("environments.list"))[0]?.params).toEqual({
          includeDesktopSetup: true,
        });
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
        await inventory.getByRole("searchbox", { name: "Find a machine…" }).fill("macOS");
        await expect.poll(() => inventory.locator(".systems-machine").count()).toBe(2);
        await page
          .locator(".systems-toolbar")
          .getByRole("button", { name: "Machine details" })
          .click();
        expect(await page.locator(".systems-details dd").allTextContents()).toContain(
          "macOS 27.0.0",
        );
        const systemReads = (await gateway.getRequests("system.info")).length;
        await gateway.deferNext("system.info");
        await inventory.getByRole("button", { name: "Refresh machines" }).click();
        await gateway.waitForRequest("system.info", { after: systemReads });
        await gateway.rejectDeferred("system.info", {
          code: "UNAVAILABLE",
          message: "Host information unavailable",
        });
        await expect
          .poll(() => inventory.locator(".systems-machine__meta").allTextContents())
          .toEqual(["macOS", "macOS 27.0.0"]);

        const enable = page.getByRole("button", { name: "Enable desktop access in OpenClaw" });
        const connectionCount = await gateway.getSocketCount();
        await gateway.deferNext("config.patch");
        await enable.click();
        const rejected = await gateway.waitForRequest("config.patch");
        if (!isRecord(rejected.params) || typeof rejected.params.raw !== "string") {
          throw new Error("Expected a serialized config patch");
        }
        expect(JSON.parse(rejected.params.raw)).toEqual({
          desktop: { host: { enabled: true } },
        });
        expect(rejected.params.baseHash).toBe("desktop-config-0");
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "Desktop configuration could not be saved",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "Desktop configuration could not be saved" })
          .waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

        await gateway.deferNext("config.patch");
        await enable.click();
        await gateway.waitForRequest("config.patch", { after: 1 });
        const enabledConfig = {
          desktop: { host: { ...originalConfig.desktop.host, enabled: true } },
        };
        await gateway.setMethodResponse("config.get", {
          config: enabledConfig,
          raw: JSON.stringify(enabledConfig),
          hash: "desktop-config-1",
          valid: true,
          issues: [],
        });
        await gateway.resolveDeferred("config.patch", {
          config: enabledConfig,
          hash: "desktop-config-1",
        });
        await page.getByRole("heading", { name: "Desktop access is enabled" }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "desktop-enabled-applying.png") });
        expect(await gateway.getRequests("config.patch")).toHaveLength(2);

        await gateway.setMethodResponse("desktop.observe", {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "macOS account credentials are required to observe Screen Sharing",
            details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "ard-account" },
          },
        });
        await gateway.setMethodResponse("environments.list", {
          environments: [
            {
              id: "gateway",
              type: "local",
              label: "Gateway Mac",
              platform: "darwin",
              status: "available",
              desktop: true,
            },
          ],
        });
        await gateway.emitGatewayEvent("config.changed", { hash: "desktop-config-1" });
        const observed = await gateway.waitForRequest("desktop.observe");
        expect(observed.params).toEqual({ source: { kind: "host" }, control: false });
        await page.getByLabel("macOS username").waitFor();
        expect(await gateway.getSocketCount()).toBe(connectionCount);
        await page.screenshot({ path: path.join(artifacts, "desktop-account-access.png") });
      },
    );
  });

  it.each(["needs-server", "unsupported", "managed"] as const)(
    "shows the next step for %s without enabling access",
    async (state) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const gateway = await installSystemsGateway(page, 0, {
            "environments.list": {
              environments: [
                {
                  id: "gateway",
                  type: "local",
                  label: "Gateway machine",
                  platform: "linux",
                  status: "available",
                  desktopSetup: { state },
                },
              ],
            },
          });
          await page.goto(suite.server.baseUrl + "systems");
          const next = page.getByRole("button", {
            name: state === "managed" ? "Enable desktop access in OpenClaw" : "Check again",
          });
          await next.waitFor();
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
          if (state !== "managed") {
            const reads = (await gateway.getRequests("environments.list")).length;
            await next.click();
            await gateway.waitForRequest("environments.list", { after: reads });
          }
        },
      );
    },
  );

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
