import { expect, it } from "vitest";
import { snapshotListFixture } from "../pages/cloud-workers/cloud-worker-snapshots.test-support.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud worker snapshots mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("requires provider cleanup acknowledgement before recovery and refreshes the snapshots", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = snapshotListFixture();
    const gateway = await installMockGateway(page, {
      featureMethods: ["crabbox.images.list", "crabbox.images.recover"],
      methodResponses: {
        "crabbox.images.list": initial,
        "crabbox.images.recover": {
          images: [],
          legacyLeases: [],
          recoveredCapture: "capture-uncertain",
          nextSteps: "Restart the Gateway.",
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Snapshots", exact: true }).click();
      await page.getByText("github.com/acme/app", { exact: true }).waitFor();
      await page.getByText("Paused: uncertain", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Recover", exact: true }).click();
      const dialog = await waitForConfirmModal(page);
      const confirm = dialog.getByRole("button", { name: "Recover", exact: true });
      const acknowledgement = dialog.getByRole("checkbox", {
        name: "I stopped the owning capture and worker and reconciled provider artifacts",
      });
      expect(await confirm.isDisabled()).toBe(true);
      expect(await gateway.getRequests("crabbox.images.recover")).toHaveLength(0);
      await acknowledgement.check();
      expect(await confirm.isEnabled()).toBe(true);
      await acknowledgement.uncheck();
      expect(await confirm.isDisabled()).toBe(true);
      await acknowledgement.check();
      const recovered = {
        ...initial,
        images: initial.images.filter((image) => image.capture?.selector !== "capture-uncertain"),
      };
      await gateway.setMethodResponse("crabbox.images.list", recovered);
      await confirm.click();
      expect((await gateway.waitForRequest("crabbox.images.recover")).params).toEqual({
        selector: "capture-uncertain",
        acknowledgeProviderCleanup: true,
      });
      await expect.poll(() => gateway.getRequests("crabbox.images.list")).toHaveLength(2);
      await expect.poll(() => page.getByText("Paused: uncertain", { exact: true }).count()).toBe(0);
      await page
        .getByText(
          "Capture reservation cleared. Restart the Gateway after reconciliation; the next eligible worker can capture again.",
          { exact: true },
        )
        .waitFor();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => gateway.getRequests("crabbox.images.list")).toHaveLength(3);
    } finally {
      await context.close();
    }
  });
});
