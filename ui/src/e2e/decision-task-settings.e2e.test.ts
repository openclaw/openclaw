import type { Page } from "playwright";
import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Decision task settings",
  startServerBeforeBrowser: true,
});
const taskId = "sample/check";
const inherit = "__openclaw_inherit_decision__";
const decisionModels = [
  { provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" },
  { provider: "typesafe", id: "jev-preview", name: "Jev Preview", pluginId: "typesafe" },
];

function configSnapshot(config: unknown, hash = "decision-0") {
  return {
    config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    hash,
    valid: true,
    issues: [],
  };
}

function installDecisionGateway(
  page: Page,
  config: unknown,
  scenario: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    ...scenario,
    methodResponses: {
      "models.list": {
        models: [],
        decisionModels,
        decisionTasks: [{ id: taskId, title: "Decision model" }],
      },
      "config.get": configSnapshot(config),
      "models.authStatus": { ts: 1, providers: [] },
      ...scenario.methodResponses,
    },
  });
}

suite.define(() => {
  it("adds inventory without assignment and replaces every saved use before removing a model", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const extra = {
        provider: "typesafe",
        id: "jev-small",
        name: "Jev Small",
        pluginId: "typesafe",
      };
      let config: unknown = {
        models: { decisionModels: ["typesafe/jev-latest", "typesafe/jev-preview"] },
        agents: {
          defaults: {
            decisionModel: "typesafe/jev-latest",
            decisionModelsByTask: { [taskId]: "typesafe/jev-preview" },
          },
          entries: {
            main: { default: true },
            disabled: {
              decisionModel: "",
              decisionModelsByTask: { "sample/dormant": "typesafe/jev-latest" },
            },
          },
        },
      };
      let revision = 0;
      const snapshot = () => configSnapshot(config, `inventory-${revision}`);
      const gateway = await installDecisionGateway(page, config, {
        methodResponses: {
          "models.list": {
            models: [],
            decisionModels: [...decisionModels, extra],
            decisionTasks: [
              { id: taskId, title: "Decision model" },
              { id: "sample/dormant", title: "Dormant task" },
            ],
          },
          "config.get": snapshot(),
        },
      });
      const save = async (act: () => Promise<unknown>) => {
        const before = (await gateway.getRequests("config.patch")).length;
        await gateway.deferNext("config.patch");
        await act();
        const request = await gateway.waitForRequest("config.patch", { after: before });
        config = applyMergePatch(config, requestRaw(request));
        revision++;
        await gateway.setMethodResponse("config.get", snapshot());
        await gateway.resolveDeferred("config.patch", { ...snapshot(), ok: true });
        return request;
      };
      const inventoryRow = (ref: string) => page.locator(`[data-decision-model-ref="${ref}"]`);
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await inventoryRow("typesafe/jev-latest").waitFor();
      const beforeAgents = structuredClone((config as { agents: unknown }).agents);
      const beforeSetup = (await gateway.getRequests("config.patch")).length;
      await page.locator("#decision-model-add").click();
      const add = page.locator("openclaw-select-picker:has(#decision-model-setup-choice)");
      await selectPickerValue(add, "typesafe/jev-small");
      expect((await gateway.getRequests("config.patch")).length).toBe(beforeSetup);
      expect(await page.locator("#decision-model-configure-provider").getAttribute("href")).toBe(
        "/settings/plugins/typesafe?view=settings",
      );
      await save(() => page.locator("#decision-model-add-confirm").click());
      await inventoryRow("typesafe/jev-small").waitFor();
      expect((config as { agents: unknown }).agents).toEqual(beforeAgents);
      const unused = await save(() =>
        inventoryRow("typesafe/jev-small")
          .getByRole("button", { name: "Remove", exact: true })
          .click(),
      );
      expect(requestRaw(unused)).not.toHaveProperty("agents");
      expect(unused.params).toMatchObject({ replacePaths: ["models.decisionModels"] });
      await page.reload();
      await inventoryRow("typesafe/jev-latest")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      await page.locator("#decision-model-remove-confirm").waitFor();
      expect(await page.locator("#decision-model-remove-confirm").isDisabled()).toBe(true);
      expect(await inventoryRow("typesafe/jev-latest").textContent()).toContain(
        "disabled · Dormant task",
      );
      const beforeCancel = (await gateway.getRequests("config.patch")).length;
      await page.locator("#decision-model-remove-cancel").click();
      expect((await gateway.getRequests("config.patch")).length).toBe(beforeCancel);
      await inventoryRow("typesafe/jev-latest")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      await selectPickerValue(
        page.locator("openclaw-select-picker:has(#decision-model-replacement)"),
        "typesafe/jev-preview",
      );
      await save(() => page.locator("#decision-model-remove-confirm").click());
      expect(config).toHaveProperty("models.decisionModels", ["typesafe/jev-preview"]);
      expect(config).toHaveProperty("agents.defaults.decisionModel", "typesafe/jev-preview");
      expect(config).toHaveProperty(
        "agents.defaults.decisionModelsByTask.sample/check",
        "typesafe/jev-preview",
      );
      expect(config).toHaveProperty("agents.entries.disabled.decisionModel", "");
      expect(config).toHaveProperty(
        "agents.entries.disabled.decisionModelsByTask.sample/dormant",
        "typesafe/jev-preview",
      );
      await page.reload();
      await inventoryRow("typesafe/jev-preview").waitFor();
      expect(await inventoryRow("typesafe/jev-latest").count()).toBe(0);
    });
  });

  it("saves task-only defaults and agent overrides without changing scalar models or neighboring tasks", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        let config: unknown = {
          models: { decisionModels: ["typesafe/jev-latest", "typesafe/jev-preview"] },
          agents: {
            defaults: { decisionModelsByTask: { "sample/triage": "" } },
            entries: { main: { default: true }, scout: { decisionModel: "typesafe/jev-preview" } },
          },
        };
        let revision = 0;
        const snapshot = () => configSnapshot(config, `task-${revision}`);
        const gateway = await installDecisionGateway(page, config, {
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "main", name: "Main" },
                { id: "scout", name: "Scout" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
            },
            "config.get": snapshot(),
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        const row = () => page.locator(`[data-decision-task-id="${taskId}"]`);
        const picker = () => row().locator("openclaw-select-picker");
        const accept = async (
          method: "config.patch" | "config.set",
          request: Parameters<typeof requestRaw>[0],
        ) => {
          const value = requestRaw(request);
          config = method === "config.patch" ? applyMergePatch(config, value) : value;
          revision++;
          await gateway.setMethodResponse("config.get", snapshot());
          await gateway.resolveDeferred(method, { ...snapshot(), ok: true });
        };
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await expect.poll(() => pickerValue(picker())).toBe(inherit);
        for (const value of ["typesafe/jev-latest", "", inherit, "typesafe/jev-latest"]) {
          const before = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await selectPickerValue(picker(), value);
          const request = await gateway.waitForRequest("config.patch", { after: before });
          expect(requestRaw(request)).toMatchObject({
            agents: {
              defaults: { decisionModelsByTask: { [taskId]: value === inherit ? null : value } },
            },
          });
          await accept("config.patch", request);
          await page.reload();
          await expect.poll(() => pickerValue(picker())).toBe(value);
          expect(config).toHaveProperty("agents.defaults.decisionModelsByTask.sample/triage", "");
          expect(config).not.toHaveProperty("agents.defaults.model");
          expect(config).not.toHaveProperty("agents.defaults.decisionModel");
        }
        await page.goto(`${suite.server.baseUrl}settings/agents/scout/overview`);
        await expect.poll(() => pickerValue(picker())).toBe(inherit);
        expect(await row().textContent()).toContain("Jev");
        for (const value of ["typesafe/jev-preview", "", inherit]) {
          await selectPickerValue(picker(), value);
          const before = (await gateway.getRequests("config.set")).length;
          await gateway.deferNext("config.set");
          await page
            .locator(".settings-section:has(#agent-decision-model)")
            .getByRole("button", { name: "Save", exact: true })
            .click();
          const request = await gateway.waitForRequest("config.set", { after: before });
          await accept("config.set", request);
          if (value === inherit) {
            expect(config).not.toHaveProperty(
              "agents.entries.scout.decisionModelsByTask.sample/check",
            );
          } else {
            expect(config).toHaveProperty(
              "agents.entries.scout.decisionModelsByTask.sample/check",
              value,
            );
          }
          expect(config).toHaveProperty(
            "agents.entries.scout.decisionModel",
            "typesafe/jev-preview",
          );
          expect(config).toHaveProperty(
            "agents.defaults.decisionModelsByTask.sample/check",
            "typesafe/jev-latest",
          );
          await page.reload();
          await expect.poll(() => pickerValue(picker())).toBe(value);
        }
        await selectPickerValue(picker(), "typesafe/jev-preview");
        const scalar = page.locator("openclaw-select-picker:has(#agent-decision-model)");
        await selectPickerValue(scalar, "");
        const before = (await gateway.getRequests("config.set")).length;
        await gateway.deferNext("config.set");
        await page
          .locator(".settings-section:has(#agent-decision-model)")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        await accept("config.set", await gateway.waitForRequest("config.set", { after: before }));
        await page.reload();
        await expect.poll(() => pickerValue(scalar)).toBe("");
        expect(config).toHaveProperty(
          "agents.entries.scout.decisionModelsByTask.sample/check",
          "typesafe/jev-preview",
        );
        expect(await picker().locator("button").first().isDisabled()).toBe(true);
        expect(await row().textContent()).toMatch(/disabled/i);
      },
    );
  });
  it("keeps unavailable selections on save failure and has no manual task creation", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = {
        models: { decisionModels: ["typesafe/jev-latest", "typesafe/jev-preview"] },
        agents: {
          defaults: { decisionModelsByTask: { [taskId]: "missing/model" } },
          entries: { main: { default: true } },
        },
      };
      const gateway = await installDecisionGateway(page, config);
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const row = page.locator(`[data-decision-task-id="${taskId}"]`);
      const picker = row.locator("openclaw-select-picker");
      await expect.poll(() => pickerValue(picker)).toBe("missing/model");
      expect(await picker.textContent()).toContain("unavailable");
      await gateway.deferNext("config.patch");
      await selectPickerValue(picker, "typesafe/jev-latest");
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Synthetic save conflict",
      });
      await page.getByRole("alert").filter({ hasText: "Synthetic save conflict" }).waitFor();
      await expect.poll(() => pickerValue(picker)).toBe("missing/model");
      expect(await page.getByRole("textbox", { name: "Task ID", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Add task", exact: true }).count()).toBe(0);
    });
  });

  it("keeps task controls read-only without config write authority", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = {
        models: { decisionModels: ["typesafe/jev-latest", "typesafe/jev-preview"] },
        agents: {
          defaults: { decisionModelsByTask: { [taskId]: "typesafe/jev-latest" } },
          entries: { main: { default: true } },
        },
      };
      const gateway = await installDecisionGateway(page, config, {
        operatorScopes: ["operator.read"],
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const picker = page.locator(`[data-decision-task-id="${taskId}"] openclaw-select-picker`);
      await expect.poll(() => pickerValue(picker)).toBe("typesafe/jev-latest");
      expect(await picker.locator("button").first().isDisabled()).toBe(true);
      expect(await page.getByRole("textbox", { name: "Task ID", exact: true }).count()).toBe(0);
      expect((await gateway.getRequests("config.patch")).length).toBe(0);
    });
  });
});
