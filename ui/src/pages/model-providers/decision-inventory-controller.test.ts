// @vitest-environment node
import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, ModelCatalogResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "../../lib/config/config-test-harness.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import {
  runModelProviderConfigMutation,
  type ModelProviderConfigMutation,
} from "./config-mutation.ts";
import { DecisionInventoryController } from "./decision-inventory-controller.ts";

const catalog: ModelCatalogResult = {
  models: [],
  decisionModels: ["one", "two", "three"].map((id) => ({
    provider: "fixture",
    id,
    name: id,
    pluginId: "fixture",
  })),
};
const capabilities = new Set<RuntimeConfigCapability>();

afterEach(() => {
  for (const capability of capabilities) {
    capability.dispose();
  }
  capabilities.clear();
});

it("starts and cancels setup without writing inventory or task assignments", async () => {
  const { controller, submissions } = await createHarness({}, {});
  controller.view(catalog).decisionInventory.onSetup?.("");
  expect(controller.view(catalog).decisionInventory.setupRef).toBe("");
  controller.view(catalog).decisionInventory.onSetup?.("fixture/one");
  expect(controller.view(catalog).decisionInventory.setupRef).toBe("fixture/one");
  expect(submissions).toEqual([]);
  controller.view(catalog).decisionInventory.onSetup?.(null);
  expect(controller.view(catalog).decisionInventory.setupRef).toBeNull();
  expect(submissions).toEqual([]);
});

it.each(["restricted", "retired"])(
  "does not recover saved references from a %s catalog",
  async (state) => {
    const { controller } = await createHarness(
      {
        models: { decisionModels: ["private/model"] },
        agents: {
          defaults: {
            decisionModel: "private/model",
            decisionModelsByTask: { "private/task": "private/model" },
          },
        },
      },
      {},
    );
    controller.view(catalog).decisionInventory.onSetup?.("fixture/one");
    const view = controller.view({
      ...catalog,
      ...(state === "retired"
        ? { retired: true }
        : { modelSelectionPolicy: { restricted: true as const, defaultModel: null } }),
    });
    expect(view.decisionInventory.inventory).toEqual([]);
    expect(view.decisionModels).toEqual([]);
    expect(view.decisionInventory.setupRef).toBeNull();
  },
);

async function createHarness(
  config: Record<string, unknown>,
  concurrentPatch: Record<string, unknown>,
) {
  const store = createConfigServerMock();
  await store.request("config.set", { raw: JSON.stringify(config), baseHash: store.currentHash() });
  const submissions: Array<{ raw: string; baseHash: string; replacePaths?: string[] }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method !== "config.patch") {
      return store.request(method, params);
    }
    const submission = params as (typeof submissions)[number];
    submissions.push(submission);
    const snapshot = (await store.request("config.get")) as ConfigSnapshot;
    if (submissions.length === 1) {
      await store.request("config.set", {
        raw: JSON.stringify(applyMergePatch(snapshot.config, concurrentPatch)),
        baseHash: snapshot.hash,
      });
    }
    if (submission.baseHash !== store.currentHash()) {
      throw new Error("config changed since last load; re-run config.get and retry");
    }
    return store.request("config.set", {
      raw: JSON.stringify(applyMergePatch(snapshot.config, JSON.parse(submission.raw))),
      baseHash: submission.baseHash,
    });
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  capabilities.add(runtimeConfig);
  await runtimeConfig.ensureLoaded();
  const host: ReactiveControllerHost = {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const gateway = new GatewayPageController(host, { getGateway: () => null });
  const patchConfig = vi.fn((mutation: ModelProviderConfigMutation) =>
    runModelProviderConfigMutation(
      {
        runtimeConfig,
        isCurrentClient: () => true,
        isCurrentAgent: () => true,
        setBusy: vi.fn(),
        setMessage: vi.fn(),
      },
      mutation,
    ),
  );
  const controller = new DecisionInventoryController(host, {
    getConfig: () => currentConfigObject(runtimeConfig.state),
    getGateway: () => gateway,
    patchConfig,
  });
  const refreshAfterConflict = async () => {
    expect(patchConfig).toHaveBeenCalledOnce();
    await patchConfig.mock.results[0]!.value;
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    await runtimeConfig.refresh();
  };
  return { controller, runtimeConfig, submissions, refreshAfterConflict };
}

describe("decision inventory config retries", () => {
  it("rebuilds Add from the refreshed inventory without losing concurrent models or saved uses", async () => {
    const { controller, runtimeConfig, submissions, refreshAfterConflict } = await createHarness(
      { models: { decisionModels: ["fixture/one"] } },
      {
        models: { decisionModels: ["fixture/one", "fixture/three"] },
        agents: { defaults: { decisionModelsByTask: { "sample/new": "saved/model" } } },
      },
    );
    controller.view(catalog).decisionInventory.onAdd("fixture/two");
    await refreshAfterConflict();
    await expect(runtimeConfig.retry()).resolves.toBe(true);
    expect(JSON.parse(submissions[1]!.raw)).toEqual({
      models: { decisionModels: ["fixture/one", "fixture/three", "saved/model", "fixture/two"] },
    });
    expect(currentConfigObject(runtimeConfig.state)).toEqual({
      models: { decisionModels: ["fixture/one", "fixture/three", "saved/model", "fixture/two"] },
      agents: { defaults: { decisionModelsByTask: { "sample/new": "saved/model" } } },
    });
  });

  it("rebuilds removal and all current uses while retaining the confirmed replacement", async () => {
    const { controller, runtimeConfig, submissions, refreshAfterConflict } = await createHarness(
      {
        models: { decisionModels: ["fixture/one", "fixture/two"] },
        agents: {
          defaults: {
            decisionModel: "fixture/one",
            decisionModelsByTask: { decision_evaluate: "fixture/one" },
          },
        },
      },
      {
        models: { decisionModels: ["fixture/one", "fixture/two", "fixture/three"], providers: {} },
        agents: {
          defaults: {
            decisionModel: "",
            decisionModelsByTask: {
              decision_evaluate: "fixture/three",
              "sample/new": "fixture/one",
              "sample/off": "",
            },
          },
          entries: {
            new: { decisionModel: "fixture/one", model: "chat/keep" },
            disabled: {
              decisionModel: "",
              decisionModelsByTask: { "sample/dormant": "fixture/one", "sample/off": "" },
            },
          },
        },
      },
    );
    const actions = controller.view(catalog).decisionInventory;
    actions.onRemove("fixture/one");
    actions.onReplacement("fixture/two");
    actions.onConfirmRemove();
    await refreshAfterConflict();
    actions.onReplacement("fixture/three");
    await expect(runtimeConfig.retry()).resolves.toBe(true);
    expect(submissions[1]?.replacePaths).toEqual(["models.decisionModels"]);
    expect(currentConfigObject(runtimeConfig.state)).toEqual({
      models: { decisionModels: ["fixture/two", "fixture/three"], providers: {} },
      agents: {
        defaults: {
          decisionModel: "",
          decisionModelsByTask: {
            decision_evaluate: "fixture/three",
            "sample/new": "fixture/two",
            "sample/off": "",
          },
        },
        entries: {
          new: { decisionModel: "fixture/two", model: "chat/keep" },
          disabled: {
            decisionModel: "",
            decisionModelsByTask: { "sample/dormant": "fixture/two", "sample/off": "" },
          },
        },
      },
    });
  });

  it.each(["replacement removed", "new use without replacement"])(
    "rejects a removal retry when the current config invalidates it: %s",
    async (scenario) => {
      const referenced = scenario === "replacement removed";
      const { controller, runtimeConfig, submissions, refreshAfterConflict } = await createHarness(
        {
          models: { decisionModels: ["fixture/one", "fixture/two"] },
          ...(referenced ? { agents: { defaults: { decisionModel: "fixture/one" } } } : {}),
        },
        {
          models: { decisionModels: ["fixture/one", "fixture/three"] },
          agents: { defaults: { decisionModel: "fixture/one" } },
        },
      );
      const actions = controller.view(catalog).decisionInventory;
      actions.onRemove("fixture/one");
      if (referenced) {
        actions.onReplacement("fixture/two");
        actions.onConfirmRemove();
      }
      await refreshAfterConflict();
      await expect(runtimeConfig.retry()).resolves.toBe(false);
      expect(submissions).toHaveLength(1);
      expect(currentConfigObject(runtimeConfig.state)).toEqual({
        models: { decisionModels: ["fixture/one", "fixture/three"] },
        agents: { defaults: { decisionModel: "fixture/one" } },
      });
    },
  );

  it("does not reuse another model's replacement when an unused removal gains a saved use", async () => {
    const { controller, runtimeConfig, submissions, refreshAfterConflict } = await createHarness(
      {
        models: { decisionModels: ["fixture/one", "fixture/two", "fixture/three"] },
        agents: { defaults: { decisionModel: "fixture/one" } },
      },
      { agents: { defaults: { decisionModelsByTask: { "sample/new": "fixture/three" } } } },
    );
    const actions = controller.view(catalog).decisionInventory;
    actions.onRemove("fixture/one");
    actions.onReplacement("fixture/two");
    actions.onRemove("fixture/three");
    await refreshAfterConflict();
    await expect(runtimeConfig.retry()).resolves.toBe(false);
    expect(submissions).toHaveLength(1);
    expect(currentConfigObject(runtimeConfig.state)).toEqual({
      models: { decisionModels: ["fixture/one", "fixture/two", "fixture/three"] },
      agents: {
        defaults: {
          decisionModel: "fixture/one",
          decisionModelsByTask: { "sample/new": "fixture/three" },
        },
      },
    });
  });
});
