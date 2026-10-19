// Control UI E2E: switching the exec-approvals target while the policy draft is
// dirty must confirm first. Cancel keeps the target, the edited form, the scope
// and the dirty flag; confirming switches and clears. The failure this guards is
// silent — nothing throws and no request is sent, the draft simply vanishes — so
// every assertion reads observable draft state rather than an error string.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI exec approvals dirty target switch",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const operatorConfig = {
  agents: { entries: { main: { default: true, name: "Main" }, reviewer: { name: "Reviewer" } } },
};

function approvals(security: string, hash: string) {
  return {
    path: "/tmp/openclaw-e2e/exec-approvals.json",
    exists: true,
    hash,
    file: {
      defaults: { security, ask: "on-miss", askFallback: "deny", autoAllowSkills: false },
      agents: { reviewer: { security: "allowlist", ask: "on-miss", askFallback: "deny" } },
    },
  };
}

const execApprovalsNode = (nodeId: string, displayName: string) => ({
  nodeId,
  displayName,
  commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
});

function gatewayOptions() {
  return {
    featureMethods: [
      "agents.list",
      "chat.metadata",
      "chat.startup",
      "config.get",
      "device.pair.list",
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.node.get",
      "exec.approvals.node.set",
      "node.list",
    ],
    methodResponses: {
      "config.get": {
        config: operatorConfig,
        sourceConfig: operatorConfig,
        hash: "config-hash-1",
        issues: [],
        raw: JSON.stringify(operatorConfig),
        valid: true,
      },
      "device.pair.list": { paired: [], pending: [] },
      "exec.approvals.get": approvals("deny", "gateway-hash-1"),
      "exec.approvals.set": { ok: true },
      "exec.approvals.node.get": approvals("deny", "node-hash-1"),
      "exec.approvals.node.set": { ok: true },
      "node.list": {
        nodes: [execApprovalsNode("node-alpha", "Alpha"), execApprovalsNode("node-beta", "Beta")],
      },
      "system-presence": [],
      "environments.list": { environments: [] },
    },
  };
}

suite.define(() => {
  it("confirms before discarding a dirty draft on Gateway to node and node to node switches", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, gatewayOptions());

      await page.goto(`${suite.server.baseUrl}nodes`);
      await gateway.waitForRequest("exec.approvals.get");

      const section = page.locator(".settings-section", { hasText: "Exec approvals" });
      const hostSelect = section.getByRole("combobox", { name: "Host" });
      const saveButton = section.getByRole("button", { name: "Save", exact: true });
      const defaultsMode = section.getByRole("combobox", { name: "Mode" }).first();
      const unloadedHint = section.getByText("Load exec approvals to edit allowlists.");
      const dialog = page.locator("openclaw-modal-dialog").last();

      // --- Precondition: a dirty draft on the Gateway target -----------------
      await expect.poll(() => defaultsMode.inputValue()).toBe("deny");
      expect(await saveButton.isEnabled()).toBe(false);

      await defaultsMode.selectOption("full");
      // Dirty is observable through the Save button, which is gated on it.
      await expect.poll(() => saveButton.isEnabled()).toBe(true);
      expect(await defaultsMode.inputValue()).toBe("full");
      expect(await hostSelect.inputValue()).toBe("gateway");

      // --- Gateway -> node, cancelled: the draft must survive ----------------
      const nodeGetsBefore = (await gateway.getRequests("exec.approvals.node.get")).length;
      await hostSelect.selectOption("node");

      // At base no dialog appears at all and the draft is already gone here.
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });

      await expect.poll(() => hostSelect.inputValue()).toBe("gateway");
      expect(await defaultsMode.inputValue()).toBe("full");
      expect(await saveButton.isEnabled()).toBe(true);
      // A cancelled switch must not talk to the Gateway.
      expect(await gateway.getRequests("exec.approvals.node.get")).toHaveLength(nodeGetsBefore);

      // --- Gateway -> node, confirmed: switches and clears -------------------
      await hostSelect.selectOption("node");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Discard changes" }).click();
      await dialog.waitFor({ state: "hidden" });

      await expect.poll(() => hostSelect.inputValue()).toBe("node");
      // The cleared draft shows as the unloaded state for the new target.
      await unloadedHint.waitFor();

      // --- nodeA -> nodeB, cancelled then confirmed --------------------------
      const nodeSelect = section.getByRole("combobox", { name: "Node" });
      await expect.poll(() => nodeSelect.inputValue()).toBe("node-alpha");
      await section.getByRole("button", { name: "Load approvals" }).click();
      await gateway.waitForRequest("exec.approvals.node.get");
      await expect.poll(() => defaultsMode.inputValue()).toBe("deny");

      await defaultsMode.selectOption("allowlist");
      await expect.poll(() => saveButton.isEnabled()).toBe(true);

      const nodeGetsBeforeCancel = (await gateway.getRequests("exec.approvals.node.get")).length;
      await nodeSelect.selectOption("node-beta");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });

      await expect.poll(() => nodeSelect.inputValue()).toBe("node-alpha");
      expect(await defaultsMode.inputValue()).toBe("allowlist");
      expect(await saveButton.isEnabled()).toBe(true);
      expect(await gateway.getRequests("exec.approvals.node.get")).toHaveLength(
        nodeGetsBeforeCancel,
      );

      await nodeSelect.selectOption("node-beta");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Discard changes" }).click();
      await dialog.waitFor({ state: "hidden" });

      await expect.poll(() => nodeSelect.inputValue()).toBe("node-beta");
      await unloadedHint.waitFor();
    });
  });

  it("switches without confirming when the draft is clean", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, gatewayOptions());

      await page.goto(`${suite.server.baseUrl}nodes`);
      await gateway.waitForRequest("exec.approvals.get");

      const section = page.locator(".settings-section", { hasText: "Exec approvals" });
      const hostSelect = section.getByRole("combobox", { name: "Host" });
      await expect.poll(() => hostSelect.inputValue()).toBe("gateway");

      await hostSelect.selectOption("node");
      await expect.poll(() => hostSelect.inputValue()).toBe("node");
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    });
  });
});
