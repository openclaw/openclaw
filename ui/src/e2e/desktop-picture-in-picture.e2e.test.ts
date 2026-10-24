import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";
import { canvasPixel } from "./panel-fixtures.test-support.ts";

type PiPOpener = Window & { documentPictureInPicture?: { window: Window | null } };
const suite = createControlUiE2eSuite({ name: "desktop Picture-in-Picture" });
suite.define(() => {
  it("keeps real noVNC frames live in native PiP behind another tab, without claiming control", async () => {
    await suite.withPage({}, async ({ page, context }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["environments.status", "desktop.observe"],
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=pip-fixture",
            control: false,
          },
        },
      });
      await page.goto(suite.server.baseUrl + "focus/desktop/source/gateway");
      await gateway.waitForRequest("environments.status");
      const peer = await installScriptedRfbServer(page);
      await gateway.resolveDeferred("environments.status", {
        id: "gateway",
        type: "local",
        status: "available",
        desktop: true,
      });
      await gateway.waitForRequest("desktop.observe");
      await gateway.resolveDeferred("desktop.observe");
      const panel = page.locator("openclaw-desktop-panel");
      const button = panel.getByRole("button", {
        name: "Open desktop in Picture-in-Picture",
        exact: true,
      });
      await expect.poll(() => button.isEnabled()).toBe(true);
      await peer.send([createRfbRawFrame()]);
      await expect
        .poll(() => canvasPixel(panel.locator(".desktop-surface canvas"), 10))
        .toEqual([24, 180, 160, 255]);
      const [pipPage] = await Promise.all([context.waitForEvent("page"), button.click()]);
      const active = () =>
        page.evaluate(() => Boolean((window as PiPOpener).documentPictureInPicture?.window));
      const pixel = () => canvasPixel(pipPage.locator("canvas"), 10);
      await expect.poll(active).toBe(true);
      await peer.send([createRfbRawFrame()]);
      await expect.poll(pixel).toEqual([24, 180, 160, 255]);
      // Disable Playwright's focus override to exercise background scheduling.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const otherTab = await context.newPage();
      await otherTab.bringToFront();
      // Visible PiP can keep opener visibilityState "visible"; check focus instead.
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      const replacement = createRfbRawFrame();
      for (let i = 16; i < replacement.length; i += 4) {
        replacement.splice(i, 4, 210, 60, 80, 0);
      }
      await peer.send([replacement]);
      await expect.poll(pixel).toEqual([210, 60, 80, 255]);
      expect(await gateway.getRequests("desktop.observe")).toEqual([
        expect.objectContaining({ params: expect.objectContaining({ control: false }) }),
      ]);
      // Input events in PiP must not reach the remote desktop.
      await pipPage.locator("canvas").evaluate((canvas) => {
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
        canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.close();
      });
      await expect.poll(active).toBe(false);
      expect(await peer.keyEvents()).toEqual([]);
      expect(await peer.events()).toEqual(["authenticated:1"]);
      await page.bringToFront();
      await button.click();
      await expect.poll(active).toBe(true);
      await peer.disconnect("fixture disconnected");
      await expect.poll(active).toBe(false);
      await panel.getByText(/fixture disconnected/).waitFor();
    });
  });
});
