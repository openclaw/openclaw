import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Device binding capability lifecycle" });
const nodes = [
  {
    nodeId: "default-node",
    displayName: "Default worker",
    connected: true,
    commands: ["system.run"],
  },
  {
    nodeId: "agent-node",
    displayName: "Research worker",
    connected: true,
    commands: ["system.run"],
  },
];
const makeConfig = (defaultBinding: string, agentBinding: string) => ({
  tools: { exec: { node: defaultBinding } },
  agents: {
    entries: {
      main: { default: true },
      research: { name: "Research", tools: { exec: { node: agentBinding } } },
    },
  },
});

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
          const gateway = await installMockGateway(page, {
            operatorScopes: [
              "operator.admin",
              "operator.read",
              "operator.write",
              "operator.pairing",
            ],
            methodResponses: {
              "node.list": { nodes },
              "config.get": {
                config,
                sourceConfig: config,
                runtimeConfig: config,
                hash: "binding-fixture",
                issues: [],
                raw: JSON.stringify(config),
                valid: true,
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/devices`);
          const section = page.locator(".settings-section").filter({
            has: page.locator(".settings-section__heading", { hasText: "Exec node binding" }),
          });
          const defaultSelect = section.getByRole("combobox", { name: "Node", exact: true });
          const researchSelect = section
            .locator(".settings-row")
            .filter({
              has: page.locator(".settings-row__title", { hasText: "Research (research)" }),
            })
            .getByRole("combobox");
          await expect(defaultSelect).toHaveValue(defaultBinding);
          await expect(researchSelect).toHaveValue(agentBinding);
          await expect(defaultSelect.locator("option:checked")).toBeEnabled();
          await expect(researchSelect.locator("option:checked")).toBeEnabled();
          const saveButton = section.getByRole("button", { name: "Save", exact: true });
          await expect(saveButton).toBeDisabled();
          const capture = async (name: string) => {
            await section.scrollIntoViewIfNeeded();
            for (const select of [defaultSelect, researchSelect]) {
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
          if (
            (await defaultSelect.inputValue()) !== defaultBinding ||
            (await researchSelect.inputValue()) !== agentBinding
          ) {
            throw new Error(
              "BINDING_SELECTION_LOSS_133032: inventory refresh dropped a saved binding from the selected options",
            );
          }
          await expect(saveButton).toBeDisabled();
          await expect(defaultSelect).toHaveValue(defaultBinding);
          await expect(researchSelect).toHaveValue(agentBinding);
          await expect(defaultSelect.locator("option:checked")).toHaveText(
            `${defaultBinding} (Unavailable)`,
          );
          await expect(researchSelect.locator("option:checked")).toHaveText(
            `${agentBinding} (Unavailable)`,
          );

          await gateway.setMethodResponse("node.list", { nodes });
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
          await expect(defaultSelect).toBeEnabled();
          await expect(defaultSelect).toHaveValue(defaultBinding);
          await expect(researchSelect).toHaveValue(agentBinding);
          await expect(defaultSelect.locator("option:checked")).toHaveText(
            "Default worker · default-node",
          );
          await expect(researchSelect.locator("option:checked")).toHaveText(
            "Research worker · agent-node",
          );
          await capture("recovered.png");
          await expect(saveButton).toBeDisabled();
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
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
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "node.list": { nodes },
            "config.get": {
              config,
              sourceConfig: config,
              raw: JSON.stringify(config),
              hash: "binding-clear-fixture",
              valid: true,
              issues: [],
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
            has: page
              .locator(".settings-row__title")
              .getByText("Research (research)", { exact: true }),
          })
          .getByRole("combobox");
        await expect(defaultSelect).toHaveValue("default-node");
        await expect(researchSelect).toHaveValue("agent-node");
        await gateway.setMethodResponse("node.list", {
          nodes:
            inventoryState === "removed" ? [] : nodes.map((node) => ({ ...node, commands: [] })),
        });
        const reads = (await gateway.getRequests("node.list")).length;
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {});
        await expect
          .poll(async () => (await gateway.getRequests("node.list")).length)
          .toBeGreaterThan(reads);
        await expect(defaultSelect.locator("option:checked")).toHaveText(
          "default-node (Unavailable)",
        );
        await expect(researchSelect.locator("option:checked")).toHaveText(
          "agent-node (Unavailable)",
        );
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, "unavailable-before-clear.png") });
        // Unavailable targets stay selected until an administrator explicitly
        // chooses the existing clear action. Clearing needs no replacement node.
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
        // Applied-state refresh must preserve the acknowledged binding removal.
        // Hold that read so this verifies the same order on fast and loaded hosts.
        const refreshReads = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await gateway.resolveDeferred("config.set");
        const indicator = page.locator("openclaw-settings-save-indicator");
        await expect(indicator).toContainText("Saved");
        await gateway.waitForRequest("config.get", { after: refreshReads });
        await gateway.resolveDeferred("config.get");
        await page.screenshot({ path: path.join(artifacts, "after-clear-refresh.png") });
        await expect(defaultSelect).toHaveValue("");
        await expect(defaultSelect).toBeDisabled();
        await expect(researchSelect).toHaveValue("agent-node");
        await expect(researchSelect).toBeEnabled();

        await gateway.deferNext("config.set");
        await researchSelect.selectOption({ label: "Use default" });
        const clearedAgent = requireRecord(
          (await gateway.waitForRequest("config.set", { after: 1 })).params,
        );
        expect(JSON.parse(String(clearedAgent.raw))).toEqual({
          tools: { exec: {} },
          agents: {
            entries: {
              main: { default: true },
              research: { name: "Research", tools: { exec: {} } },
            },
          },
        });
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
        await expect(defaultSelect).toHaveValue("");
        await expect(researchSelect).toHaveValue("__default__");
        expect(await gateway.getRequests("config.set")).toHaveLength(2);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    },
  );
});
