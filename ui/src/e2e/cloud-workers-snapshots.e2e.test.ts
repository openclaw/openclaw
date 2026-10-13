import { expect, it } from "vitest";
import type { SnapshotImage } from "../pages/cloud-workers/cloud-worker-environment-model.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "../pages/cloud-workers/cloud-worker-snapshots.test-support.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Control UI cloud environments mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (path) => `Playwright Chromium is unavailable at ${path}`,
});
function snapshot() {
  const result = snapshotListFixture();
  result.images = [
    { ...result.images[0]!, held: false, retirement: undefined, projectRoot: "/projects/app" },
  ];
  return result;
}
const methods = [
  "crabbox.images.list",
  "crabbox.images.pin",
  "crabbox.images.delete",
  "crabbox.images.rollback",
  "crabbox.images.recover",
  "environments.list",
  "environments.prepare",
  "environments.destroy",
];
suite.define(() => {
  it("rebuilds the selected repository and cancels its build after confirmation", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        "crabbox.images.list": snapshot(),
        "environments.list": { environments: [], profiles: [] },
        "environments.prepare": {
          environmentId: "build-app",
          preparationKey: "build-key",
          reused: false,
        },
        "environments.destroy": { ok: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Rebuild", exact: true }).waitFor();
      await gateway.setMethodResponse("environments.list", {
        environments: [buildEnvironmentFixture()],
        profiles: [],
      });
      await page.getByRole("button", { name: "Rebuild", exact: true }).click();
      expect((await gateway.waitForRequest("environments.prepare")).params).toEqual({
        profileId: "linux-build",
        projectPath: "/projects/app",
      });
      const cancel = page.getByRole("button", { name: "Cancel: build-app", exact: true });
      await cancel.click();
      const dialog = await waitForConfirmModal(page);
      expect(await dialog.getAttribute("label")).toBe("Cancel build");
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      await dialog.getByRole("button", { name: "Cancel build", exact: true }).click();
      expect((await gateway.waitForRequest("environments.destroy")).params).toEqual({
        environmentId: "build-app",
      });
      await expect.poll(() => cancel.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
  it("keeps failed builds in their repository sheet and dismisses only confirmed failures", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        "crabbox.images.list": snapshot(),
        "environments.list": {
          environments: [buildEnvironmentFixture("failed", "Synthetic setup failure")],
          profiles: [],
        },
        "environments.destroy": { ok: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page
        .locator(".cloud-environments__sheet")
        .getByText("Synthetic setup failure", { exact: true })
        .waitFor();
      expect(await page.locator(".cloud-environments__row").textContent()).toBe(
        "github.com/acme/appNeeds attention",
      );
      const dismiss = page.getByRole("button", { name: "Dismiss: build-app", exact: true });
      await dismiss.click();
      const dialog = await waitForConfirmModal(page);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      await dismiss.click();
      await (
        await waitForConfirmModal(page)
      )
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await gateway.waitForRequest("environments.destroy");
      await expect
        .poll(() => page.getByText("Synthetic setup failure", { exact: true }).count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
  it("recovers repository and project-less uncertain captures only after cleanup acknowledgement", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const result = snapshot();
    result.images[0]!.capture = { selector: "capture-app", phase: "uncertain", stale: false };
    const machineCapture: SnapshotImage = {
      profileKey: "profile-key-machine",
      profileId: "machine-build",
      state: "no-image",
      allocationCount: 0,
      held: false,
      capture: { selector: "capture-machine", phase: "uncertain", stale: false },
    };
    result.images.push(machineCapture);
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        "crabbox.images.list": result,
        "environments.list": { environments: [], profiles: [] },
        "crabbox.images.recover": { ok: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const sheet = page.locator(".cloud-environments__sheet");
      await sheet.getByText("Paused: uncertain", { exact: true }).waitFor();
      expect(await page.locator(".cloud-environments__row").count()).toBe(1);
      await sheet.getByRole("button", { name: "Recover", exact: true }).click();
      const dialog = await waitForConfirmModal(page);
      const recover = dialog.getByRole("button", { name: "Recover", exact: true });
      expect(await recover.isDisabled()).toBe(true);
      await dialog.getByRole("checkbox").check();
      const repositoryRecovered = snapshot();
      repositoryRecovered.images.push(machineCapture);
      await gateway.setMethodResponse("crabbox.images.list", repositoryRecovered);
      await recover.click();
      expect((await gateway.waitForRequest("crabbox.images.recover")).params).toEqual({
        selector: "capture-app",
        acknowledgeProviderCleanup: true,
      });
      await expect
        .poll(() => sheet.getByText("Paused: uncertain", { exact: true }).count())
        .toBe(0);
      const advanced = page.locator(".cloud-environments__advanced");
      await advanced.locator("summary").click();
      await advanced.getByText("Paused: uncertain", { exact: true }).waitFor();
      await advanced.getByRole("button", { name: "Recover", exact: true }).click();
      const machineDialog = await waitForConfirmModal(page);
      const recoverMachine = machineDialog.getByRole("button", { name: "Recover", exact: true });
      expect(await recoverMachine.isDisabled()).toBe(true);
      await machineDialog.getByRole("checkbox").check();
      await gateway.setMethodResponse("crabbox.images.list", snapshot());
      await recoverMachine.click();
      expect((await gateway.waitForRequest("crabbox.images.recover", { after: 1 })).params).toEqual(
        { selector: "capture-machine", acknowledgeProviderCleanup: true },
      );
      await expect
        .poll(() => advanced.getByText("Paused: uncertain", { exact: true }).count())
        .toBe(0);
      expect(await page.locator(".cloud-environments__row").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
  it("pins, unpins, rolls back and deletes the second profile snapshot without changing the first", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const result = snapshot();
    const firstImage = result.images[0]!;
    const secondImage = {
      ...firstImage,
      profileKey: "profile-key-arm",
      profileId: "arm-build",
      checkpointId: "image-arm",
      baseCommit: "abcdef0123456789",
      previous: { checkpointId: "image-arm-previous", createdAtMs: 1234 },
    };
    result.images.push(secondImage);
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        "crabbox.images.list": result,
        "environments.list": { environments: [], profiles: [] },
        "crabbox.images.pin": {},
        "crabbox.images.rollback": {},
        "crabbox.images.delete": { status: "deleted" },
      },
    });
    const secondSnapshot = page.locator('.cloud-environments__snapshot[aria-label="arm-build"]');
    const menu = async (label: string) => {
      await secondSnapshot
        .getByRole("button", { name: "Environment actions", exact: true })
        .click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page
        .locator(".cloud-environments__sheet")
        .getByText("01234567", { exact: true })
        .waitFor();
      await secondSnapshot.getByText("abcdef01", { exact: true }).waitFor();
      expect(await page.locator(".cloud-environments__row").count()).toBe(1);
      const pinned = {
        ...result,
        images: [firstImage, { ...secondImage, pinned: { atMs: 1000 } }],
      };
      await gateway.setMethodResponse("crabbox.images.list", pinned);
      await menu("Pin");
      expect((await gateway.waitForRequest("crabbox.images.pin")).params).toEqual({
        checkpointId: "image-arm",
        pinned: true,
      });
      await secondSnapshot
        .getByRole("button", { name: "Environment actions", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
      expect(
        await page
          .getByRole("menuitem", { name: "Delete", exact: true })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      await gateway.setMethodResponse("crabbox.images.list", result);
      await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("crabbox.images.pin")).length)
        .toBe(2);
      expect((await gateway.getRequests("crabbox.images.pin"))[1]?.params).toEqual({
        checkpointId: "image-arm",
        pinned: false,
      });
      const restored = {
        ...result,
        images: [
          firstImage,
          {
            ...secondImage,
            checkpointId: "image-arm-previous",
            previous: { checkpointId: "image-arm", createdAtMs: 1234 },
          },
        ],
      };
      await menu("Roll back");
      const rollback = await waitForConfirmModal(page);
      await gateway.setMethodResponse("crabbox.images.list", restored);
      await rollback.getByRole("button", { name: "Roll back", exact: true }).click();
      expect((await gateway.waitForRequest("crabbox.images.rollback")).params).toEqual({
        checkpointId: "image-arm-previous",
      });
      await menu("Delete");
      const deletion = await waitForConfirmModal(page);
      await deletion.getByText("image-arm-previous", { exact: true }).waitFor();
      await gateway.setMethodResponse("crabbox.images.list", { ...result, images: [firstImage] });
      await deletion.getByRole("button", { name: "Delete", exact: true }).click();
      expect((await gateway.waitForRequest("crabbox.images.delete")).params).toEqual({
        checkpointId: "image-arm-previous",
      });
      await expect.poll(() => secondSnapshot.count()).toBe(0);
      await page
        .locator(".cloud-environments__sheet")
        .getByText("01234567", { exact: true })
        .waitFor();
      expect(await page.locator(".cloud-environments__row").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
