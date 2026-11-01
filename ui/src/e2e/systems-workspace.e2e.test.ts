import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { revealSidebarTarget } from "../test-helpers/control-ui-sidebar-window.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandSidebarSessions } from "./sidebar-session-pagination.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Systems workspace mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const systemInfo = {
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
};
const workerHistory = (state: "destroyed" | "failed", ageMs = 1_000) => ({
  state,
  profileId: "cloud",
  providerId: "crabbox",
  ...(state === "destroyed" ? { leaseId: "released-lease" } : {}),
  ageMs,
  attachedSessionIds: [],
  tunnelStatus: "stopped",
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
            worker: workerHistory(state),
          })),
        ],
      },
      "node.list": { nodes: [] },
      "system.info": systemInfo,
      "backup.status": { targets: [], schedules: [], locations: [] },
      ...methodResponses,
    },
  });
}

suite.define(() => {
  it.each(
    [400, 820, 1280].flatMap((width) =>
      [1, 4, 12].flatMap((diskCount) =>
        [false, true].map((backups) => ({ width, diskCount, backups })),
      ),
    ),
  )(
    "keeps the overview steady at $width px with $diskCount disks (backups: $backups)",
    async ({ width, diskCount, backups }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installSystemsGateway(page, 0, {
            "system.info": {
              ...systemInfo,
              disks: Array.from({ length: diskCount }, (_, index) => ({
                path: `/volume-${index}`,
                totalBytes: 1024 ** 4,
                availableBytes: (diskCount - index) * 1024 ** 3,
              })),
            },
            "backup.status": {
              targets: backups
                ? [
                    {
                      kind: "archive",
                      target: "Synthetic archive",
                      latest: {
                        id: "backup",
                        kind: "archive",
                        createdAt: 1,
                        archivePath: "/backup",
                        status: "failed",
                        error: "Archive disk disconnected",
                      },
                    },
                  ]
                : [],
              schedules: [],
              locations: [],
            },
          });
          await page.goto(suite.server.baseUrl + "new");
          await waitForControlUiRoute(page, { routeId: "new-session" });
          const outletOrigin = () =>
            page.locator("openclaw-router-outlet").evaluate((element) => {
              const { x, y } = element.getBoundingClientRect();
              return { x, y };
            });
          const initialOrigin = await outletOrigin();
          const inventoryReads = await gateway.deferNext("environments.list");
          const backupReads = await gateway.deferNext("backup.status");
          await page.evaluate(() => {
            window.openclawControlUi!.navigate("systems");
          });
          await gateway.waitForRequest("environments.list", { after: inventoryReads });
          await gateway.waitForRequest("backup.status", { after: backupReads });
          await page.getByText("Loading backups…", { exact: true }).waitFor();
          expect(await outletOrigin()).toEqual(initialOrigin);
          const body = page.locator(".systems-body");
          expect(await body.locator(".systems-state").isVisible()).toBe(false);
          const position = () => body.evaluate((element) => element.getBoundingClientRect().y);
          const initialY = await position();
          const backupY = await page
            .locator(".systems-backups")
            .evaluate((element) => element.getBoundingClientRect().y);
          await expect
            .poll(() =>
              page.evaluate(() =>
                document
                  .getAnimations()
                  .every(
                    (animation) =>
                      !Number.isFinite(animation.effect?.getComputedTiming().endTime) ||
                      animation.playState === "finished",
                  ),
              ),
            )
            .toBe(true);
          const shifts = await page.evaluateHandle(() => {
            let cls = 0;
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const shift = entry as PerformanceEntry & {
                  hadRecentInput: boolean;
                  value: number;
                };
                if (!shift.hadRecentInput) {
                  cls += shift.value;
                }
              }
            });
            observer.observe({ type: "layout-shift", buffered: false });
            return { read: () => cls, stop: () => observer.disconnect() };
          });

          await gateway.resolveDeferred("environments.list");
          await page.locator(".systems-volume-summary").waitFor();
          await expect.poll(position).toBe(initialY);
          expect(await body.locator(".systems-state").isVisible()).toBe(true);
          expect(await page.locator(".systems-backups").textContent()).toContain(
            "Loading backups…",
          );
          await gateway.resolveDeferred("backup.status");
          await page
            .getByText(backups ? "Recorded: 1 · Failed: 1" : "No backups recorded —", {
              exact: false,
            })
            .waitFor();
          expect(await position()).toBe(initialY);
          expect(
            await page
              .locator(".systems-backups")
              .evaluate((element) => element.getBoundingClientRect().y),
          ).toBe(backupY);
          expect(await page.locator(".systems-volume-summary li:not([aria-hidden])").count()).toBe(
            Math.min(3, diskCount),
          );
          expect(
            await page
              .locator(".systems-overview")
              .evaluate((element) => element.scrollHeight <= element.clientHeight),
          ).toBe(true);
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              }),
          );
          expect(await shifts.evaluate((probe) => probe.read())).toBe(0);
          await shifts.evaluate((probe) => probe.stop());
          await shifts.dispose();
          const more = page.locator(".systems-volume-summary button");
          await more.focus();
          await page.keyboard.press("Enter");
          await page.locator(".systems-details").waitFor();
          expect(await page.locator(".systems-details .systems-vital--disk").count()).toBe(
            diskCount,
          );
          expect(
            await page
              .locator(".systems-details")
              .evaluate((element) => element === document.activeElement),
          ).toBe(true);
          if (backups) {
            await page.getByText("Archive disk disconnected", { exact: true }).waitFor();
          }
          await page.getByRole("button", { name: "Close details" }).click();
          await expect
            .poll(() => more.evaluate((element) => element === document.activeElement))
            .toBe(true);

          // Selecting a worker removes Gateway backups and may have no telemetry.
          const picker = page.locator(".systems-mobile-picker");
          if (await picker.isVisible()) {
            await picker.selectOption("worker-one");
          } else {
            const worker = page
              .locator(".systems-sidebar")
              .getByRole("button", { name: /Cloud worker/ });
            if (!(await worker.isVisible())) {
              await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
            }
            await worker.click();
          }
          await expect.poll(() => page.locator(".systems-backups").count()).toBe(0);
          expect(await position()).toBe(initialY);
        },
      );
    },
  );
  it("names Macs consistently and enables a discovered desktop without reconnecting", async () => {
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
            ...systemInfo,
            machineName: "Gateway Mac",
            platform: "darwin",
            release: "26.0.0",
            arch: "arm64",
            osLabel: "macOS 27.0.0",
            cpuCount: 8,
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

        await expect
          .poll(() => inventory.locator(".systems-machine__meta").allTextContents())
          .toEqual(["macOS 27.0.0", "macOS 27.0.0"]);
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
    "scrolls the %s middle sidebar without moving the personal rail",
    async (route) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 900 },
        },
        async ({ page }) => {
          // The middle column no longer includes the navigation stack: overflow its own roster.
          await installSystemsGateway(page, 40);
          await page.goto(suite.server.baseUrl + route);
          await page.locator('[data-navigation-view="pages"]').click();
          await expect.poll(() => page.locator(".systems-sidebar").count()).toBe(0);
          await page.locator('[data-navigation-view="sessions"]').click();
          const home = page.locator(".sidebar-rail__bottom .sidebar-footer-bar__home");
          const scroller = page.locator(".sidebar-shell__body");
          const railControls = page.locator(
            ".sidebar-rail__bottom :is(.sidebar-footer-bar__home, .sidebar-issues-button, .sidebar-identity-card)",
          );
          const railBounds = () =>
            railControls.evaluateAll((controls) =>
              controls.map((control) => {
                const { x, y, width, height } = control.getBoundingClientRect();
                return { x, y, width, height };
              }),
            );
          const row = page
            .locator(route === "systems" ? ".systems-machine" : ".sidebar-recent-session")
            .first();
          await row.waitFor();
          if (route === "dashboards") {
            await expandSidebarSessions(scroller, 30);
            await revealSidebarTarget(
              scroller,
              page.locator('.sidebar-recent-session[data-session-key="agent:main:task-29"]'),
            );
            await scroller.evaluate((element) => {
              element.scrollTop = 0;
            });
            await page
              .locator('.sidebar-recent-session[data-session-key="agent:main:task-0"]')
              .waitFor();
          }
          const homeTop = () => home.evaluate((element) => element.getBoundingClientRect().top);
          const rowTop = () => row.evaluate((element) => element.getBoundingClientRect().top);
          await home.hover();
          await row.hover();
          const initialHomeTop = await homeTop();
          const initialRowTop = await rowTop();
          const firstRow = await row.elementHandle();
          const initialRailBounds = await railBounds();
          expect(initialRailBounds).toHaveLength(3);

          await page.mouse.wheel(0, 160);
          await expect
            .poll(() =>
              firstRow!.evaluate(
                (element, top) =>
                  !element.isConnected || element.getBoundingClientRect().top < top - 80,
                initialRowTop,
              ),
            )
            .toBe(true);

          expect(await homeTop()).toBe(initialHomeTop);
          expect(await railBounds()).toEqual(initialRailBounds);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(80);

          await page.mouse.wheel(0, -1000);
          await expect.poll(rowTop).toBeCloseTo(initialRowTop, 0);
          await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
          await home.hover();
          await page.mouse.wheel(0, 120);
          expect(await homeTop()).toBe(initialHomeTop);
          expect(await railBounds()).toEqual(initialRailBounds);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
          expect(await rowTop()).toBeCloseTo(initialRowTop, 0);
          await firstRow!.dispose();
        },
      );
    },
  );

  it("loads the lazy workspace and keeps its machine picker aligned after navigation", async () => {
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
        .poll(() => page.locator(".systems-heading h2").textContent())
        .toBe("Cloud worker");

      expect(await inventory.getByRole("button", { name: /worker history/ }).count()).toBe(0);
      expect(await inventory.locator(".systems-group__count").allTextContents()).toEqual(["1"]);
      await page.locator('[data-navigation-view="pages"]').click();
      await page.locator('.sidebar-pages a[href$="/dashboards"]').click();
      await expect.poll(() => page.locator(".systems-sidebar").count()).toBe(0);
      await page.locator('.sidebar-pages a[href$="/systems"]').click();
      await page.locator('[data-navigation-view="sessions"]').click();
      await inventory.waitFor();
      await expect
        .poll(() => page.locator(".systems-heading h2").textContent())
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
            worker: workerHistory("destroyed", 2_000),
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
