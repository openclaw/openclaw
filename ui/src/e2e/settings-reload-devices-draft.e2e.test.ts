import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Devices bindings during Settings reload" });
const requireRecord = createRequireRecord("record", "expected-object-value");
const config = {
  agents: { entries: { main: { default: true } } },
  tools: { exec: { node: "disk-node" } },
};
const snapshot = {
  exists: true,
  valid: true,
  config,
  raw: JSON.stringify(config),
  hash: "persisted-revision",
};

suite.define(() => {
  it.each([false, true])(
    "locks bindings during Reload and resumes edits afterward (read failure: %s)",
    async (failFirstRead) => {
      await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir("settings-reload-devices-draft");
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": snapshot,
            "node.list": {
              nodes: ["disk-node", "new-node"].map((nodeId) => ({
                nodeId,
                displayName: nodeId,
                platform: "linux",
                commands: ["system.run"],
                connected: true,
                paired: true,
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
        await reload.waitFor();
        const reads = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await reload.click();
        await gateway.waitForRequest("config.get", { after: reads });
        await binding.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, "pending-reload.png") });
        // The whole binding editor follows the pending authoritative read, so
        // Reload cannot silently overwrite input accepted after it started.
        await expect.poll(() => binding.isDisabled()).toBe(true);
        expect(await agentBinding.isDisabled()).toBe(true);
        expect(await save.isDisabled()).toBe(true);
        await page.screenshot({ path: path.join(artifacts, "locked-reload.png") });
        expect(await binding.inputValue()).toBe("new-node");
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        if (failFirstRead) {
          await gateway.rejectDeferred("config.get", {
            code: "UNAVAILABLE",
            message: "Synthetic config read failure",
          });
          await expect.poll(() => binding.isEnabled()).toBe(true);
          expect(await agentBinding.isEnabled()).toBe(true);
          expect(await save.isEnabled()).toBe(true);
          expect(await binding.inputValue()).toBe("new-node");
          const retryReads = (await gateway.getRequests("config.get")).length;
          await gateway.deferNext("config.get");
          await reload.click();
          await gateway.waitForRequest("config.get", { after: retryReads });
          await expect.poll(() => binding.isDisabled()).toBe(true);
        }
        await gateway.resolveDeferred("config.get", snapshot);
        await expect.poll(() => binding.isEnabled()).toBe(true);
        expect(await binding.inputValue()).toBe("disk-node");
        expect(await agentBinding.isEnabled()).toBe(true);
        expect(await save.isDisabled()).toBe(true);
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
        await expect.poll(() => indicator.textContent()).toContain("Saved");
        expect(await binding.inputValue()).toBe("new-node");
        expect(await save.isDisabled()).toBe(true);
      });
    },
  );
});
