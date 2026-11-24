import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { logbookStatus, logbookTimeline } from "../pages/plugin/logbook.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook capture scope" });
suite.define(() => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 400, height: 900 },
  ])("keeps capture scope and the empty timeline clear on $name", async (viewport) => {
    await suite.withPage({ ...createControlUiE2eContextOptions(), viewport }, async ({ page }) => {
      const day = "2026-11-14";
      let status = logbookStatus(day, {
        todayCards: 0,
        pendingFrames: 7,
        analysisRunning: true,
        visionModelSource: "config",
      });
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
        methodResponses: { "logbook.status": status, "logbook.timeline": logbookTimeline(day) },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=logbook&id=logbook`);
      const view = page.locator(".logbook");
      const toggle = view.locator(".logbook__actions button").first();
      await toggle.waitFor();
      await page.getByText("Analyzing…", { exact: true }).waitFor();
      const capture = async (stage: string) => {
        const frame = await takeControlUiScreenshotFrame(
          page,
          view,
          [toggle, view.locator(".logbook__empty-sub")],
          { animations: "disabled" },
        );
        await writeFile(
          path.join(suite.artifactDir, viewport.name + "-" + stage + ".png"),
          frame.png,
        );
      };
      await capture("capturing");
      status = { ...status, capturePaused: true };
      await gateway.setMethodResponse("logbook.capture.set", status);
      await gateway.setMethodResponse("logbook.status", status);
      await gateway.deferNext("logbook.capture.set");
      await toggle.click();
      expect((await gateway.waitForRequest("logbook.capture.set")).params).toEqual({
        paused: true,
      });
      await expect.poll(() => toggle.isDisabled()).toBe(true);
      await capture("pausing");
      expect
        .soft(await view.locator(".logbook__chip").first().textContent())
        .toBe("Pausing capture…");
      expect.soft(await page.getByText("Capture paused", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("logbook.capture.set", status);
      await page.getByText("Capture paused", { exact: true }).waitFor();
      await expect.poll(() => toggle.isDisabled()).toBe(false);
      await capture("paused");
      expect.soft(await toggle.textContent()).toBe("Resume capture");
      expect(await view.getByText("Analyzing…", { exact: true }).isVisible()).toBe(true);
      expect(await view.getByRole("button", { name: "Analyze now" }).isEnabled()).toBe(true);
      expect(await gateway.getRequests("logbook.analyze.now")).toHaveLength(0);
      status = { ...status, capturePaused: false };
      await gateway.setMethodResponse("logbook.capture.set", status);
      await gateway.setMethodResponse("logbook.status", status);
      await toggle.click();
      expect((await gateway.waitForRequest("logbook.capture.set", { after: 1 })).params).toEqual({
        paused: false,
      });
      await expect.poll(() => toggle.isDisabled()).toBe(false);
      expect.soft(await toggle.textContent()).toBe("Pause capture");
      status = { ...status, captureEnabled: false, analysisRunning: false };
      await gateway.setMethodResponse("logbook.status", status);
      await view.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByText("Capture off", { exact: true }).waitFor();
      await capture("off");
      expect(await toggle.isDisabled()).toBe(true);
      expect
        .soft(await view.locator(".logbook__empty-sub").textContent())
        .toBe("Activity appears here after captured snapshots are analyzed.");
      expect(await gateway.getRequests("logbook.capture.set")).toHaveLength(2);
    });
  });
});
