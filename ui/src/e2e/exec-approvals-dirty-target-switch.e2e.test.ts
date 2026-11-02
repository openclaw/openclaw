import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
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
        ...configSnapshot(operatorConfig, "config-hash-1"),
        sourceConfig: operatorConfig,
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

const defaultsRow = (section: Locator) =>
  section.locator("summary").getByText("Defaults", { exact: true });

suite.define(() => {
  it("confirms before discarding a dirty draft and loads the next host", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, section, hostSelect } = await openApprovals(page);
      const saveButton = section.getByRole("button", { name: "Save", exact: true });
      const security = section.getByRole("combobox", { name: "Security" }).first();
      const dialog = page.locator("openclaw-modal-dialog").last();
      const switchHost = async (value: string, decision: string) => {
        await hostSelect.selectOption(value);
        await dialog.waitFor();
        await dialog.getByRole("button", { name: decision }).click();
        await dialog.waitFor({ state: "hidden" });
      };
      await defaultsRow(section).click();
      await expect.poll(() => security.inputValue()).toBe("deny");
      expect(await saveButton.count()).toBe(0);
      for (const [from, to, mode] of [
        ["__gateway__", "node-alpha", "full"],
        ["node-alpha", "node-beta", "allowlist"],
      ] as const) {
        await security.selectOption(mode);
        await expect.poll(() => saveButton.isEnabled()).toBe(true);
        expect(await hostSelect.inputValue()).toBe(from);
        const requestsBefore = (await gateway.getRequests("exec.approvals.node.get")).length;
        await switchHost(to, "Cancel");
        await expect.poll(() => hostSelect.inputValue()).toBe(from);
        expect({
          mode: await security.inputValue(),
          dirty: await saveButton.isEnabled(),
        }).toEqual({ mode, dirty: true });
        expect(await gateway.getRequests("exec.approvals.node.get")).toHaveLength(requestsBefore);
        await switchHost(to, "Discard changes");
        await expect.poll(() => hostSelect.inputValue()).toBe(to);
        await gateway.waitForRequest("exec.approvals.node.get", { after: requestsBefore });
        await defaultsRow(section).waitFor();
        await expect.poll(() => saveButton.count()).toBe(0);
        await defaultsRow(section).click();
        await expect.poll(() => security.inputValue()).toBe("deny");
      }
    }));

  it("switches without confirming when the draft is clean", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { hostSelect } = await openApprovals(page);
      await expect.poll(() => hostSelect.inputValue()).toBe("__gateway__");

      await hostSelect.selectOption("node-alpha");
      await expect.poll(() => hostSelect.inputValue()).toBe("node-alpha");
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    }));

  it("saves an allowlist edit and keeps the row open", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, section } = await openApprovals(page);
      const reviewer = section.locator("details").filter({
        has: page.locator("summary", { hasText: "Reviewer (reviewer)" }),
      });
      await reviewer.locator("summary").click();
      await reviewer.getByRole("button", { name: "Add pattern" }).click();
      const pattern = reviewer.getByRole("textbox", { name: "Pattern" });
      await expect.poll(() => pattern.evaluate((el) => el === document.activeElement)).toBe(true);
      await pattern.fill("/usr/bin/git*");
      await section.getByRole("button", { name: "Save", exact: true }).click();
      const saved = await gateway.waitForRequest("exec.approvals.set");
      expect(saved.params).toMatchObject({
        baseHash: "gateway-hash-1",
        file: { agents: { reviewer: { allowlist: [{ pattern: "/usr/bin/git*" }] } } },
      });
      await section.getByText("Saved", { exact: true }).waitFor();
      expect(await reviewer.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    }));

  it("shows a failed load in place and retries it", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, section, hostSelect } = await openApprovals(page);
      await defaultsRow(section).waitFor();
      await gateway.deferNext("exec.approvals.node.get");
      await hostSelect.selectOption("node-alpha");
      await gateway.waitForRequest("exec.approvals.node.get");
      await gateway.rejectDeferred("exec.approvals.node.get", {
        code: "UNAVAILABLE",
        message: "Node is offline",
      });
      await section.getByText("Couldn't load approvals", { exact: true }).waitFor();
      await section.getByText("Node is offline").waitFor();
      expect(await page.locator(".callout.danger").count()).toBe(0);
      await section.getByRole("button", { name: "Retry", exact: true }).click();
      await defaultsRow(section).waitFor();
    }));
});
