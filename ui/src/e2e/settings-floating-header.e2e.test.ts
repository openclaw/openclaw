import { expect, it } from "vitest";
import { pathForRoute } from "../app-route-paths.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI phone floating-header layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("switches the floating header, rows and controls together at 640", async () => {
    const context = await suite.browser.newContext({
      ...createDarkDesktopControlUiContextOptions(),
      viewport: { height: 900, width: 640 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "node.list": { ts: 0, nodes: [] },
        "device.pair.list": { pending: [], paired: [] },
        "system-presence": [],
      },
    });

    try {
      const pathname = pathForRoute("connection");
      await page.goto(new URL(pathname, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname, routeId: "connection" });
      await page.locator(".settings-row--stacked-on-narrow").first().waitFor();
      const read = () =>
        page.evaluate(() => ({
          floating: document.querySelector(".shell--floating-header") !== null,
          control: getComputedStyle(document.documentElement)
            .getPropertyValue("--settings-control-height")
            .trim(),
          row: getComputedStyle(document.querySelector(".settings-row--stacked-on-narrow")!)
            .flexDirection,
        }));
      await expect.poll(read).toEqual({ floating: true, control: "38px", row: "column" });
      await page.setViewportSize({ height: 900, width: 641 });
      await expect.poll(read).toEqual({ floating: false, control: "32px", row: "row" });
      // Short pages must fill the shell, not leave a retired notice track below them.
      await page.setViewportSize({ height: 900, width: 390 });
      const devicesPath = pathForRoute("devices");
      await page.goto(new URL(devicesPath, suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { pathname: devicesPath, routeId: "devices" });
      await page.getByText("No paired devices yet.", { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.locator(".shell--floating-header").evaluate((shell) => {
            const content = shell.querySelector("main.content")!;
            const shellBox = shell.getBoundingClientRect();
            const contentBox = content.getBoundingClientRect();
            return Math.round(shellBox.bottom - contentBox.bottom);
          }),
        )
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
