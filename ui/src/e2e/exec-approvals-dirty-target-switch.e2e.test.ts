import type { Locator, Page } from "playwright";
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

function approvals(hash: string) {
  return {
    path: "/tmp/openclaw-e2e/exec-approvals.json",
    exists: true,
    hash,
    file: {
      defaults: { security: "deny", ask: "on-miss", askFallback: "deny", autoAllowSkills: false },
      agents: { reviewer: { security: "allowlist", ask: "on-miss", askFallback: "deny" } },
    },
  };
}

const execApprovalsNode = (nodeId: string, displayName: string) => ({
  nodeId,
  displayName,
  commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
});

async function openApprovals(page: Page) {
  const gateway = await installMockGateway(page, {
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
      "exec.approvals.get": approvals("gateway-hash-1"),
      "exec.approvals.node.get": approvals("node-hash-1"),
      "node.list": {
        nodes: [execApprovalsNode("node-alpha", "Alpha"), execApprovalsNode("node-beta", "Beta")],
      },
      "system-presence": [],
      "environments.list": { environments: [] },
    },
  });
  await page.goto(`${suite.server.baseUrl}nodes`);
  await gateway.waitForRequest("exec.approvals.get");
  const section = page.locator(".settings-section", { hasText: "Exec approvals" });
  return { gateway, section, hostSelect: section.getByRole("combobox", { name: "Host" }) };
}

suite.define(() => {
  it("confirms before discarding a dirty draft on Gateway to node and node to node switches", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, section, hostSelect } = await openApprovals(page);
      const saveButton = section.getByRole("button", { name: "Save", exact: true });
      const defaultsMode = section.getByRole("combobox", { name: "Mode" }).first();
      const unloadedHint = section.getByText("Load exec approvals to edit allowlists.");
      const dialog = page.locator("openclaw-modal-dialog").last();
      const switchTarget = async (select: Locator, value: string, decision: string) => {
        await select.selectOption(value);
        await dialog.waitFor();
        await dialog.getByRole("button", { name: decision }).click();
        await dialog.waitFor({ state: "hidden" });
      };
      const nodeSelect = section.getByRole("combobox", { name: "Node" });
      await expect.poll(() => defaultsMode.inputValue()).toBe("deny");
      expect(await saveButton.isEnabled()).toBe(false);
      for (const [select, from, to, mode] of [
        [hostSelect, "gateway", "node", "full"],
        [nodeSelect, "node-alpha", "node-beta", "allowlist"],
      ] satisfies Array<[Locator, string, string, string]>) {
        if (select === nodeSelect) {
          await expect.poll(() => select.inputValue()).toBe(from);
          await section.getByRole("button", { name: "Load approvals" }).click();
          await gateway.waitForRequest("exec.approvals.node.get");
          await expect.poll(() => defaultsMode.inputValue()).toBe("deny");
        }
        await defaultsMode.selectOption(mode);
        await expect.poll(() => saveButton.isEnabled()).toBe(true);
        expect(await defaultsMode.inputValue()).toBe(mode);
        expect(await select.inputValue()).toBe(from);
        const requestsBefore = (await gateway.getRequests("exec.approvals.node.get")).length;
        await switchTarget(select, to, "Cancel");
        await expect.poll(() => select.inputValue()).toBe(from);
        expect({
          mode: await defaultsMode.inputValue(),
          dirty: await saveButton.isEnabled(),
        }).toEqual({ mode, dirty: true });
        expect(await gateway.getRequests("exec.approvals.node.get")).toHaveLength(requestsBefore);
        await switchTarget(select, to, "Discard changes");
        await expect.poll(() => select.inputValue()).toBe(to);
        await unloadedHint.waitFor();
      }
    });
  });

  it("switches without confirming when the draft is clean", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { hostSelect } = await openApprovals(page);
      await expect.poll(() => hostSelect.inputValue()).toBe("gateway");

      await hostSelect.selectOption("node");
      await expect.poll(() => hostSelect.inputValue()).toBe("node");
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    });
  });
});
