import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Settings navigation layout shift",
  startServerBeforeBrowser: true,
});

const targets = [
  { pathname: "/usage", routeId: "usage" },
  { pathname: "/templates", routeId: "templates" },
] as const;
const settings = { pathname: "/settings/model-providers", routeId: "model-providers" };
const cases = targets.flatMap((target) => [
  { from: settings, to: target, width: 400 },
  { from: settings, to: target, width: 820 },
  { from: settings, to: target, width: 1280 },
  { from: target, to: settings, width: 1280 },
]);

suite.define(() => {
  it.each(cases)(
    "keeps the shell still from $from.pathname to $to.pathname at $width px",
    ({ from, to, width }) =>
      suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const config = { gateway: { controlUi: { experimental: { templates: true } } } };
          await installMockGateway(page, {
            methodResponses: {
              "config.get": {
                config,
                sourceConfig: config,
                hash: "settings-exit-templates-config",
                valid: true,
                issues: [],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}${from.pathname.slice(1)}`);
          await waitForControlUiRoute(page, from);
          const topbarGeometry = () =>
            page.evaluate(() =>
              [".topbar-nav-toggle", ".topbar-search"].map((selector) => {
                const rect = document.querySelector(selector)?.getBoundingClientRect();
                return rect && [rect.x, rect.y, rect.width, rect.height];
              }),
            );
          const settingsTopbar = await topbarGeometry();
          const phoneUsageActions = width === 400 && to.routeId === "usage";
          const settingsNewSession = phoneUsageActions
            ? await page.locator(".header-new-session").boundingBox()
            : null;
          const phoneHeaderAnchors = () =>
            page.evaluate(() => {
              const pill = document
                .querySelector(".topnav-shell__actions")!
                .getBoundingClientRect();
              const title = document.querySelector(".topbar-page-title")!.getBoundingClientRect();
              return {
                pill: [pill.right, pill.y, pill.height],
                title: [title.x + title.width / 2, title.y, title.height],
              };
            });
          const settingsAnchors = phoneUsageActions ? await phoneHeaderAnchors() : null;
          if (phoneUsageActions) {
            expect(settingsNewSession).not.toBeNull();
            expect(await page.locator(".usage-phone-actions__trigger").count()).toBe(0);
          }
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
                    source.node instanceof Element ? source.node.className : source.node?.nodeName,
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
          }, to.pathname);
          await waitForControlUiRoute(page, to);
          if (phoneUsageActions) {
            await page
              .locator(".topnav-shell__page-actions .usage-phone-actions__trigger")
              .waitFor();
          }
          await page.waitForFunction(
            () =>
              !document
                .querySelector(".shell")
                ?.getAnimations()
                .some(
                  (animation) =>
                    animation instanceof CSSTransition &&
                    animation.transitionProperty === "grid-template-columns",
                ),
          );
          const shifts = await page.evaluate(
            () =>
              new Promise<Array<{ value: number; nodes?: unknown[] }>>((resolve) => {
                // Layout-shift entries are queued once the frame that paints them ends.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    resolve(Reflect.get(window, "__drainLayoutShifts")()),
                  ),
                );
              }),
          );
          if (phoneUsageActions) {
            // Adding a page action may grow the pill, but must not move existing controls.
            expect(await page.locator(".header-new-session").boundingBox()).toEqual(
              settingsNewSession,
            );
            expect(await phoneHeaderAnchors()).toEqual(settingsAnchors);
            // Only the pill's background may grow left when Usage adds its action.
            for (const shift of shifts) {
              expect(shift.nodes).toEqual(["topnav-shell__actions"]);
            }
          } else {
            expect(shifts).toEqual([]);
          }
          expect(await topbarGeometry()).toEqual(settingsTopbar);
        },
      ),
  );
});
