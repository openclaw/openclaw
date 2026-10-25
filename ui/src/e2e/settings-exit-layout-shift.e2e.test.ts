import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Settings exit layout shift",
  startServerBeforeBrowser: true,
});

const targets = [
  { pathname: "/usage", routeId: "usage" },
  { pathname: "/claws", routeId: "claws" },
] as const;

suite.define(() => {
  for (const target of targets) {
    it.each([400, 820])(
      `keeps the shell still from Models to ${target.pathname} at %ipx`,
      (width) =>
        suite.withPage(
          { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
          async ({ page }) => {
            const config = { gateway: { controlUi: { experimental: { claws: true } } } };
            await installMockGateway(page, {
              methodResponses: {
                "config.get": {
                  config,
                  sourceConfig: config,
                  hash: "settings-exit-claws-config",
                  valid: true,
                  issues: [],
                },
              },
            });
            await page.goto(`${suite.server.baseUrl}settings/model-providers`);
            await waitForControlUiRoute(page, {
              pathname: "/settings/model-providers",
              routeId: "model-providers",
            });
            const topbarGeometry = () =>
              page.evaluate(() =>
                [".topbar-nav-toggle", ".topbar-search", ".header-new-session"].map((selector) => {
                  const rect = document.querySelector(selector)?.getBoundingClientRect();
                  return rect && [rect.x, rect.y, rect.width, rect.height];
                }),
              );
            const settingsTopbar = await topbarGeometry();
            await page.evaluate(() => {
              const shifts: unknown[] = [];
              const record = (entries: PerformanceEntryList) => {
                for (const entry of entries) {
                  const shift = entry as PerformanceEntry & {
                    value: number;
                    sources?: { node?: Node | null }[];
                  };
                  shifts.push({
                    value: shift.value,
                    nodes: shift.sources?.map((source) =>
                      source.node instanceof Element
                        ? source.node.className
                        : source.node?.nodeName,
                    ),
                  });
                }
              };
              const observer = new PerformanceObserver((list) => record(list.getEntries()));
              observer.observe({ type: "layout-shift" });
              Reflect.set(window, "__drainLayoutShifts", () => {
                record(observer.takeRecords());
                return shifts;
              });
            });
            await page.evaluate((pathname) => {
              history.pushState(null, "", pathname);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }, target.pathname);
            await waitForControlUiRoute(page, target);
            const shifts = await page.evaluate(
              () =>
                new Promise((resolve) => {
                  // Layout-shift entries are queued once the frame that paints them ends.
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() =>
                      resolve(Reflect.get(window, "__drainLayoutShifts")()),
                    ),
                  );
                }),
            );
            expect(shifts).toEqual([]);
            expect(await topbarGeometry()).toEqual(settingsTopbar);
          },
        ),
    );
  }
});
