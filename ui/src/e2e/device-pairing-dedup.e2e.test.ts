// Control UI E2E: rapid double-click on Approve dispatches only one pairing RPC,
// node-menu approve dedup, and recovery after a failed approve.
import path from "node:path";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import { beforeEach, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device pairing dedup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("device-pairing-dedup");
  }
});

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(uiProofArtifactDir, fileName) });
}

const PENDING_REQUEST_ID = "pending-req-1";
const PENDING_DEVICE_ID = "pending-device-1";
const NODE_REQUEST_ID = "node-req-1";
const NODE_ID = "reapproval-node";

function pendingDeviceList() {
  return {
    pending: [
      {
        requestId: PENDING_REQUEST_ID,
        deviceId: PENDING_DEVICE_ID,
        displayName: "Pending Tablet",
        roles: ["operator"],
        scopes: ["operator.read"],
      },
    ],
    paired: [],
  };
}

function nodeListWithPendingReapproval() {
  return {
    nodes: [
      {
        nodeId: NODE_ID,
        displayName: "Reapproval Node",
        connected: true,
        paired: true,
        approvalState: "pending-reapproval",
        pendingRequestId: NODE_REQUEST_ID,
        commands: ["system.run"],
      },
    ],
  };
}

const BASE_METHOD_RESPONSES = {
  "environments.list": { environments: [] },
  "exec.approvals.get": {
    exists: false,
    file: { agents: {}, defaults: {}, version: 1 },
    hash: "e2e",
    path: "/tmp/exec-approvals.json",
  },
  "system-presence": [],
};

suite.define(() => {
  it("dispatches only one device approve RPC on rapid double-click and recovers after failure", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.pairing"],
        methodResponses: {
          ...BASE_METHOD_RESPONSES,
          "device.pair.list": pendingDeviceList(),
          "node.list": { nodes: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/devices`);
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });

      const row = page.locator(".settings-row", { hasText: "Pending Tablet" });
      await row.waitFor();
      await captureUiProof(page, "01-pending-device.png");

      const approveButton = row.getByRole("button", { name: "Approve", exact: true });
      await expect(approveButton).toBeEnabled();

      // --- Failure recovery: approve RPC fails, button re-enables ---
      await gateway.deferNext("device.pair.approve");
      const failCallsBefore = (await gateway.getRequests("device.pair.approve")).length;

      await approveButton.click();
      await approveButton.click({ force: true });

      await gateway.waitForRequest("device.pair.approve", { after: failCallsBefore });
      const failCalls = await gateway.getRequests("device.pair.approve");
      expect(failCalls).toHaveLength(1);

      await expect(approveButton).toBeDisabled();
      await captureUiProof(page, "02-approve-disabled-in-flight.png");

      // The pending device is still listed because the approve failed.
      await gateway.rejectDeferred("device.pair.approve", { message: "Gateway rejected" });
      await expect(approveButton).toBeEnabled();
      await captureUiProof(page, "03-approve-re-enabled-after-failure.png");

      // --- Success: approve again, this time it resolves ---
      await gateway.deferNext("device.pair.approve");
      const successCallsBefore = (await gateway.getRequests("device.pair.approve")).length;

      await approveButton.click();
      await approveButton.click({ force: true });

      await gateway.waitForRequest("device.pair.approve", { after: successCallsBefore });
      const successCalls = await gateway.getRequests("device.pair.approve");
      expect(successCalls).toHaveLength(2);

      await expect(approveButton).toBeDisabled();

      await gateway.setMethodResponse("device.pair.list", { pending: [], paired: [] });
      await gateway.resolveDeferred("device.pair.approve", { ok: true });

      await expect(row).toHaveCount(0);
      await captureUiProof(page, "04-pending-device-approved.png");

      const finalApproveCalls = await gateway.getRequests("device.pair.approve");
      expect(finalApproveCalls).toHaveLength(2);
    });
  });

  it("dispatches only one node approve RPC when the node menu Approve item is clicked twice", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.pairing"],
        methodResponses: {
          ...BASE_METHOD_RESPONSES,
          "device.pair.list": { pending: [], paired: [] },
          "node.list": nodeListWithPendingReapproval(),
          "node.pair.approve": { ok: true },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/devices`);
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });

      const row = page.locator(".device-entry", { hasText: "Reapproval Node" });
      await row.waitFor();
      await captureUiProof(page, "05-node-reapproval.png");

      // Open the dropdown menu for the node row.
      const menuTrigger = row.locator(".device-entry__menu-trigger");
      await menuTrigger.click();
      await captureUiProof(page, "06-node-menu-open.png");

      const approveItem = page.locator('wa-dropdown-item[value="approve"]');

      // Defer the node approve RPC so it stays in-flight while we click again.
      await gateway.deferNext("node.pair.approve");
      const approveCallsBefore = (await gateway.getRequests("node.pair.approve")).length;

      // Rapid double-click on the dropdown item.
      await approveItem.click();
      await approveItem.click({ force: true });

      await gateway.waitForRequest("node.pair.approve", { after: approveCallsBefore });

      const approveCalls = await gateway.getRequests("node.pair.approve");
      expect(approveCalls).toHaveLength(1);
      expect(approveCalls[0]?.params).toEqual({ requestId: NODE_REQUEST_ID });
      await captureUiProof(page, "07-node-approve-single-rpc.png");

      // The approve item must be disabled while the approve is in-flight.
      await expect(approveItem).toHaveAttribute("disabled");

      // Resolve the approve and verify the node list refreshes.
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: NODE_ID,
            displayName: "Reapproval Node",
            connected: true,
            paired: true,
            approvalState: "approved",
            commands: ["system.run"],
          },
        ],
      });
      await gateway.resolveDeferred("node.pair.approve", { ok: true });

      // The node is no longer in pending-reapproval state, so the menu
      // approve/reject items disappear.
      await expect(approveItem).toHaveCount(0);
      await captureUiProof(page, "08-node-approved.png");

      const finalApproveCalls = await gateway.getRequests("node.pair.approve");
      expect(finalApproveCalls).toHaveLength(1);
    });
  });
});
