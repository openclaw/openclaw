import { expect, it } from "vitest";
import { snapshotListFixture } from "../pages/cloud-workers/cloud-worker-snapshots.test-support.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud worker snapshots mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function buildEnvironmentFixture() {
  return {
    id: "build-app",
    type: "worker",
    status: "starting",
    preparation: { purpose: "build", key: "build-key" },
    worker: {
      profileId: "linux-build",
      providerId: "crabbox",
      leaseId: "lease-app",
      state: "provisioning",
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

suite.define(() => {
  it("builds a snapshot for the selected profile and local repository", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "crabbox.images.list",
        "environments.list",
        "environments.prepare",
        "environments.destroy",
        "projects.list",
        "worktrees.list",
      ],
      methodResponses: {
        "crabbox.images.list": snapshotListFixture(),
        "environments.list": { environments: [], profiles: [] },
        "environments.prepare": {
          environmentId: "build-app",
          preparationKey: "build-key",
          reused: false,
        },
        "projects.list": {
          projects: [
            {
              id: "app",
              displayName: "App",
              repoRoot: "/projects/app",
              source: "registered",
            },
          ],
        },
        "worktrees.list": { worktrees: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Snapshots", exact: true }).click();
      await page.getByRole("button", { name: "Build snapshot", exact: true }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Build snapshot"]');
      const submit = dialog.getByRole("button", { name: "Build snapshot", exact: true });
      await dialog
        .getByRole("combobox", { name: "Profile", exact: true })
        .selectOption("linux-build");
      await dialog
        .getByRole("combobox", { name: "Repository", exact: true })
        .selectOption("/projects/app");
      expect(await gateway.getRequests("environments.prepare")).toHaveLength(0);
      await gateway.setMethodResponse("environments.list", {
        environments: [buildEnvironmentFixture()],
        profiles: [],
      });
      await submit.click();
      expect((await gateway.waitForRequest("environments.prepare")).params).toEqual({
        profileId: "linux-build",
        projectPath: "/projects/app",
      });
      await page.getByText("Build started", { exact: true }).waitFor();
      await expect.poll(() => dialog.count()).toBe(0);
      await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("cancels a build only after confirmation and removes the reconciled build row", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["crabbox.images.list", "environments.list", "environments.destroy"],
      methodResponses: {
        "crabbox.images.list": snapshotListFixture(),
        "environments.list": { environments: [buildEnvironmentFixture()], profiles: [] },
        "environments.destroy": { ok: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Snapshots", exact: true }).click();
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      await cancel.click();
      const dialog = await waitForConfirmModal(page);
      expect(await dialog.getAttribute("label")).toBe("Cancel build");
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => dialog.count()).toBe(0);
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      await cancel.click();
      const confirmation = await waitForConfirmModal(page);
      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      await confirmation.getByRole("button", { name: "Cancel build", exact: true }).click();
      expect((await gateway.waitForRequest("environments.destroy")).params).toEqual({
        environmentId: "build-app",
      });
      await expect.poll(() => cancel.count()).toBe(0);
      await page.getByText("github.com/acme/app", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("requires provider cleanup acknowledgement before recovery and refreshes the snapshots", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = snapshotListFixture();
    const gateway = await installMockGateway(page, {
      featureMethods: ["crabbox.images.list", "crabbox.images.recover", "environments.list"],
      methodResponses: {
        "crabbox.images.list": initial,
        "environments.list": { environments: [] },
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

  it("pins a snapshot, unpins it, and confirms provider deletion with exact checkpoint payloads", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = snapshotListFixture();
    const image = initial.images.find((entry) => entry.checkpointId === "image-app");
    if (!image) {
      throw new Error("Expected project image fixture");
    }
    const unpinned = { ...image, held: false, retirement: undefined };
    const pinned = { ...unpinned, pinned: { atMs: 1234 } };
    const listed = { ...initial, images: [unpinned] };
    const gateway = await installMockGateway(page, {
      featureMethods: ["crabbox.images.list", "crabbox.images.pin", "crabbox.images.delete"],
      methodResponses: {
        "environments.list": { environments: [] },
        "crabbox.images.list": listed,
        "crabbox.images.pin": pinned,
        "crabbox.images.delete": { status: "deleted" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Snapshots", exact: true }).click();
      const row = page.locator(".settings-row").filter({ hasText: "github.com/acme/app" });
      await row.waitFor();
      await gateway.setMethodResponse("crabbox.images.list", { ...listed, images: [pinned] });
      await row.getByRole("button", { name: "Pin", exact: true }).click();
      expect((await gateway.waitForRequest("crabbox.images.pin")).params).toEqual({
        checkpointId: "image-app",
        pinned: true,
      });
      await row.getByText("Pinned", { exact: true }).waitFor();
      expect(await row.getByRole("button", { name: "Delete", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(
        await row.getByRole("button", { name: "Delete", exact: true }).getAttribute("title"),
      ).toBe("Unpin this snapshot before deleting it.");
      await gateway.setMethodResponse("crabbox.images.list", listed);
      await gateway.setMethodResponse("crabbox.images.pin", unpinned);
      await row.getByRole("button", { name: "Unpin", exact: true }).click();
      await expect.poll(() => gateway.getRequests("crabbox.images.pin")).toHaveLength(2);
      expect((await gateway.getRequests("crabbox.images.pin"))[1]?.params).toEqual({
        checkpointId: "image-app",
        pinned: false,
      });
      await expect
        .poll(() => row.getByRole("button", { name: "Delete", exact: true }).isEnabled())
        .toBe(true);
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = await waitForConfirmModal(page);
      expect(await gateway.getRequests("crabbox.images.delete")).toHaveLength(0);
      await dialog.getByText("image-app", { exact: true }).waitFor();
      await gateway.setMethodResponse("crabbox.images.list", { ...listed, images: [] });
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      expect((await gateway.waitForRequest("crabbox.images.delete")).params).toEqual({
        checkpointId: "image-app",
      });
      await expect.poll(() => row.count()).toBe(0);
      await expect.poll(() => gateway.getRequests("crabbox.images.list")).toHaveLength(4);
    } finally {
      await context.close();
    }
  });
});
