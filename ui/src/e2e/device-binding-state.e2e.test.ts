import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";
import { it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Device binding capability lifecycle" });
const nodes = [
  ["default-node", "Default worker"],
  ["agent-node", "Research worker"],
].map(([nodeId, displayName]) => ({
  nodeId,
  displayName,
  connected: true,
  commands: ["system.run"],
}));
const availableLabels = ["Default worker · default-node", "Research worker · agent-node"];
const makeConfig = (defaultBinding: string, agentBinding: string) => ({
  tools: { exec: defaultBinding ? { node: defaultBinding } : {} },
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: {
      main: {},
      research: { name: "Research", tools: { exec: agentBinding ? { node: agentBinding } : {} } },
    },
  },
});

async function bindingControls(
  page: Page,
  config: ReturnType<typeof makeConfig>,
  lifecycle = false,
) {
  const gateway = await installMockGateway(page, {
    ...(lifecycle
      ? {
          operatorScopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
        }
      : {}),
    methodResponses: {
      "node.list": { nodes },
      "config.get": {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        issues: [],
        valid: true,
        hash: lifecycle ? "binding-fixture" : "binding-clear-fixture",
        ...(lifecycle ? { runtimeConfig: config } : {}),
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/devices`);
  const section = page.locator(".settings-section").filter({
    has: page.getByRole("heading", { name: "Exec node binding", exact: true }),
  });
  const defaultSelect = section.getByRole("combobox", { name: "Node", exact: true });
  const researchSelect = section
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title").getByText("Research (research)", { exact: true }),
    })
    .getByRole("combobox");
  return { gateway, section, defaultSelect, researchSelect };
}

async function expectBindings(selects: Locator[], values: string[], labels?: string[]) {
  for (const [index, select] of selects.entries()) {
    await expect(select).toHaveValue(values[index]!);
    if (labels) {
      await expect(select.locator("option:checked")).toHaveText(labels[index]!);
    }
  }
}

async function expectWrites(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  count: number,
) {
  expect(await gateway.getRequests("config.set")).toHaveLength(count);
  expect(await gateway.getRequests("config.patch")).toHaveLength(0);
}

suite.define(() => {
  it.each([
    { kind: "ID", defaultBinding: "default-node", agentBinding: "agent-node" },
    { kind: "name", defaultBinding: "Default worker", agentBinding: "Research worker" },
  ])(
    "keeps saved $kind bindings visible through capability loss and recovery without writing config",
    async ({ defaultBinding, agentBinding }) => {
      const config = makeConfig(defaultBinding, agentBinding);
      const viewport = { width: 1280, height: 900 };
      await suite.withPage(
        { viewport, colorScheme: "dark", recordVideo: { dir: suite.artifactDir, size: viewport } },
        async ({ page }) => {
          const { gateway, section, defaultSelect, researchSelect } = await bindingControls(
            page,
            config,
            true,
          );
          const selects = [defaultSelect, researchSelect];
          const values = [defaultBinding, agentBinding];
          await expectBindings(selects, values);
          for (const select of selects) {
            await expect(select.locator("option:checked")).toBeEnabled();
          }
          const saveButton = section.getByRole("button", { name: "Save", exact: true });
          await expect(saveButton).toBeDisabled();
          const capture = async (name: string) => {
            await section.scrollIntoViewIfNeeded();
            for (const select of selects) {
              const bounds = await select.boundingBox();
              expect(bounds?.y).toBeGreaterThanOrEqual(0);
              expect(bounds && bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
            }
            await page.screenshot({ path: path.join(suite.artifactDir, name) });
          };
          await capture("available.png");

          await gateway.setMethodResponse("node.list", { nodes: [{ ...nodes[0], commands: [] }] });
          const beforeLossReads = (await gateway.getRequests("node.list")).length;
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
          await expect
            .poll(async () => (await gateway.getRequests("node.list")).length)
            .toBeGreaterThan(beforeLossReads);
          await expect(defaultSelect).toBeEnabled();
          await expect(researchSelect).toBeEnabled();
          await capture("unavailable.png");
          expect(
            await Promise.all(selects.map((select) => select.inputValue())),
            "BINDING_SELECTION_LOSS_133032",
          ).toEqual(values);
          await expect(saveButton).toBeDisabled();
          await expectBindings(
            selects,
            values,
            values.map((value) => `${value} (Unavailable)`),
          );

          await gateway.setMethodResponse("node.list", { nodes });
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
          await expect(defaultSelect).toBeEnabled();
          await expectBindings(selects, values, availableLabels);
          await capture("recovered.png");
          await expect(saveButton).toBeDisabled();
          await expectWrites(gateway, 0);
        },
      );
    },
  );

  it.each(["removed", "capability-lost"] as const)(
    "explicitly clears saved bindings when all execution nodes are %s",
    async (inventoryState) => {
      const requireRecord = createRequireRecord("record", "expected-object-value");
      const config = makeConfig("default-node", "agent-node");
      await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir("device-binding-clear");
        const { gateway, section, defaultSelect, researchSelect } = await bindingControls(
          page,
          config,
        );
        const selects = [defaultSelect, researchSelect];
        await expectBindings(selects, ["default-node", "agent-node"]);
        await gateway.setMethodResponse("node.list", {
          nodes:
            inventoryState === "removed" ? [] : nodes.map((node) => ({ ...node, commands: [] })),
        });
        const reads = (await gateway.getRequests("node.list")).length;
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
        await expect
          .poll(async () => (await gateway.getRequests("node.list")).length)
          .toBeGreaterThan(reads);
        await expectBindings(
          selects,
          ["default-node", "agent-node"],
          ["default-node (Unavailable)", "agent-node (Unavailable)"],
        );
        await expectWrites(gateway, 0);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, "unavailable-before-clear.png") });
        await expect(defaultSelect).toBeEnabled();
        await expect(researchSelect).toBeEnabled();
        await page.screenshot({ path: path.join(artifacts, "unavailable-clear-enabled.png") });
        await gateway.deferNext("config.set");
        await defaultSelect.selectOption({ label: "Any node" });
        const clearedDefault = requireRecord((await gateway.waitForRequest("config.set")).params);
        expect(JSON.parse(String(clearedDefault.raw))).toEqual({
          ...config,
          tools: { exec: {} },
        });
        // Hold refresh until the acknowledged removal is published.
        const refreshReads = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await gateway.resolveDeferred("config.set");
        const indicator = page.locator("openclaw-settings-save-indicator");
        await expect(indicator).toContainText("Saved");
        await gateway.waitForRequest("config.get", { after: refreshReads });
        await gateway.resolveDeferred("config.get");
        await page.screenshot({ path: path.join(artifacts, "after-clear-refresh.png") });
        await expectBindings(selects, ["", "agent-node"]);
        await expect(defaultSelect).toBeDisabled();
        await expect(researchSelect).toBeEnabled();

        await gateway.deferNext("config.set");
        await researchSelect.selectOption({ label: "Use default" });
        const clearedAgent = requireRecord(
          (await gateway.waitForRequest("config.set", { after: 1 })).params,
        );
        expect(JSON.parse(String(clearedAgent.raw))).toEqual(makeConfig("", ""));
        await gateway.resolveDeferred("config.set");
        await expect(indicator).toContainText("Saved");
        await expect(researchSelect).toHaveValue("__default__");
        await expect(researchSelect).toBeDisabled();
        await expect(defaultSelect).toBeDisabled();
        await page.screenshot({ path: path.join(artifacts, "unavailable-cleared.png") });

        await gateway.setMethodResponse("node.list", { nodes });
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
        await expect(
          defaultSelect.getByRole("option", { name: "Default worker · default-node", exact: true }),
        ).toHaveCount(1);
        await expectBindings(selects, ["", "__default__"]);
        await expectWrites(gateway, 2);
      });
    },
  );
});
