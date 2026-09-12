import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

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
        .poll(() =>
          panel
            .locator(".desktop-surface canvas")
            .evaluate((canvas) => [
              ...(canvas as HTMLCanvasElement).getContext("2d")!.getImageData(10, 10, 1, 1).data,
            ]),
        )
        .toEqual([24, 180, 160, 255]);
      await page.screenshot({ path: path.join(suite.artifactDir, "desktop-before-pip.png") });
      const [pipPage] = await Promise.all([context.waitForEvent("page"), button.click()]);
      const active = () =>
        page.evaluate(() => Boolean((window as PiPOpener).documentPictureInPicture?.window));
      const pixel = () =>
        page.evaluate(() => {
          const canvas = (
            window as PiPOpener
          ).documentPictureInPicture?.window?.document.querySelector("canvas");
          return canvas ? [...canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data] : null;
        });
      await expect.poll(active).toBe(true);
      await peer.send([createRfbRawFrame()]);
      await expect.poll(pixel).toEqual([24, 180, 160, 255]);
      await page.screenshot({ path: path.join(suite.artifactDir, "desktop-pip-active.png") });
      // Playwright forces every page to appear focused/visible by default, even
      // behind another tab. Remove that automation override to exercise real scheduling.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const otherTab = await context.newPage();
      await otherTab.goto("about:blank");
      await otherTab.bringToFront();
      // A visible PiP can keep its opener visibilityState "visible". Focus, not
      // visibilityState, confirms that the user has left the original viewer.
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      const replacement = createRfbRawFrame();
      for (let i = 16; i < replacement.length; i += 4) {
        replacement.splice(i, 4, 210, 60, 80, 0);
      }
      await peer.send([replacement]);
      await expect.poll(pixel).toEqual([210, 60, 80, 255]);
      await pipPage.screenshot({
        path: path.join(suite.artifactDir, "native-pip-after-tab-switch.png"),
      });
      expect(await peer.events()).toEqual(["authenticated:1"]);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      expect((await gateway.getRequests("desktop.observe"))[0]?.params).toMatchObject({
        control: false,
      });
      // PiP has no remote-input listeners, even if keyboard/pointer events arrive there.
      await page.evaluate(() => {
        const pip = (window as PiPOpener).documentPictureInPicture?.window;
        if (!pip) {
          throw new Error("Expected a native Picture-in-Picture window");
        }
        const canvas = pip.document.querySelector("canvas")!;
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
        canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        pip.close();
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
