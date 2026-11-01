import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Devices bindings during Settings reload" });
const requireRecord = createRequireRecord("record", "expected-object-value");
const config = {
  agents: { entries: { main: {} } },
  tools: { exec: { node: "disk-node" } },
};
const snapshot = {
  exists: true,
  valid: true,
  config,
  raw: JSON.stringify(config),
  hash: "persisted-revision",
};

suite.define(() =>
  it.each([false, true])(
    "locks and restores bindings during Reload (read failure: %s)",
    (failFirstRead) =>
      suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": snapshot,
            "node.list": {
              nodes: ["disk-node", "new-node"].map((nodeId) => ({
                nodeId,
                displayName: nodeId,
                commands: ["system.run"],
              })),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/devices`);
        const section = page.locator(".settings-section").filter({
          has: page.getByRole("heading", { name: "Exec node binding", exact: true }),
        });
        const binding = section.getByRole("combobox", { name: "Node", exact: true });
        const agentBinding = section.getByRole("combobox", { name: "Binding", exact: true });
        const save = section.getByRole("button", { name: "Save", exact: true });
        const expectEditor = async (node: string, disabled: boolean, saveDisabled = disabled) => {
          await expect.poll(() => binding.isDisabled()).toBe(disabled);
          expect(
            await Promise.all([binding.inputValue(), agentBinding.isDisabled(), save.isDisabled()]),
          ).toEqual([node, disabled, saveDisabled]);
        };
        await expect.poll(() => binding.inputValue()).toBe("disk-node");
        await gateway.deferNext("config.set");
        await binding.selectOption("new-node");
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "config changed since last load; re-run config.get and retry",
        });
        const indicator = page.locator("openclaw-settings-save-indicator");
        const reload = indicator.getByRole("button", { name: "Reload", exact: true });
        const startReload = async () => {
          const after = await gateway.deferNext("config.get");
          await reload.click();
          await gateway.waitForRequest("config.get", { after });
        };
        await startReload();
        await expectEditor("new-node", true);
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        if (failFirstRead) {
          await gateway.rejectDeferred("config.get", {
            code: "UNAVAILABLE",
            message: "Synthetic config read failure",
          });
          await expectEditor("new-node", false);
          await startReload();
          await expect.poll(() => binding.isDisabled()).toBe(true);
        }
        await gateway.resolveDeferred("config.get", snapshot);
        await expectEditor("disk-node", false, true);
        expect(await reload.count()).toBe(0);

        await gateway.deferNext("config.set");
        await binding.selectOption("new-node");
        const saved = requireRecord(
          (await gateway.waitForRequest("config.set", { after: 1 })).params,
        );
        expect(saved.baseHash).toBe("persisted-revision");
        expect(JSON.parse(String(saved.raw))).toEqual({
          ...config,
          tools: { exec: { node: "new-node" } },
        });
        await gateway.resolveDeferred("config.set");
        await expect.poll(() => indicator.textContent()).toContain("Apply changes");
        await expectEditor("new-node", false, true);
      }),
  ),
);
