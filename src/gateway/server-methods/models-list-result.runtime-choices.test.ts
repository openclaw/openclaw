import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ModelChoiceSchema } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { prepareModelsListResult } from "./models-list-result.js";
import {
  modelAuthStore,
  withModelsListState,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

function modelEntry(
  provider: string,
  overrides: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return {
    provider,
    id: "model",
    name: "Shared Model",
    contextWindow: 32_000,
    reasoning: false,
    input: ["text"],
    ...overrides,
  };
}
function nativeModel(base: ModelCatalogEntry, nativeRuntime: string, windowId: string) {
  return modelEntry(base.provider, {
    ...base,
    nativeRuntime,
    contextWindow: 128_000,
    reasoning: true,
    input: ["text", "image"],
    contextWindows: [
      { id: windowId, label: windowId === "large" ? "Large" : "Native", contextWindow: 128_000 },
    ],
    contextWindowDefault: windowId,
  });
}
function projectorFor(
  cfg: OpenClawConfig,
  snapshot: ModelCatalogSnapshot,
  extra: Partial<Parameters<typeof createModelCatalogDecisions>[0]> = {},
  provider?: string,
) {
  return createModelCatalogDecisions({
    cfg,
    agentId: "main",
    snapshot,
    metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
    preparedAuthStore: modelAuthStore(
      provider
        ? { [`${provider}:test`]: { type: "api_key", provider, key: "synthetic-test-key" } }
        : {},
    ),
    ...extra,
  });
}
function registryFor(id: string, overrides: Partial<AgentHarnessV2> = {}) {
  const harness: AgentHarnessV2 = {
    id,
    label: "Native fixture",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
    ...overrides,
  };
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({ pluginId: harness.id, source: "test", harness });
  return registry;
}
function expectUnavailable(choice: unknown, selectable: boolean) {
  expect(choice).toMatchObject({ available: false });
  if (selectable) {
    expectMissing(choice, "unavailableReason");
  } else {
    expect(choice).toMatchObject({ unavailableReason: "unsupported-runtime" });
  }
}

function expectMissing(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    expect(value).not.toHaveProperty(key);
  }
}
function pickerConfig(
  workspace: string,
  ref: string,
  runtime: string,
  pickerRuntimes: string[],
  modelPolicy?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["modelPolicy"],
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace,
        model: ref,
        modelPolicy,
        models: { [ref]: { agentRuntime: { id: runtime }, pickerRuntimes } },
      },
    },
  };
}

function preparePicker(
  cfg: OpenClawConfig,
  snapshot: ModelCatalogSnapshot,
  extra: Partial<Parameters<typeof createModelCatalogDecisions>[0]>,
  provider?: string,
) {
  const loadGatewayModelCatalogSnapshot = vi.fn();
  const params = {
    source: {
      kind: "gateway",
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalogSnapshot,
        logGateway: { debug: vi.fn() },
      },
    },
    agentId: "main",
    params: { view: "configured", includeDetails: true },
    preloadedCatalog: { agentId: "main", config: cfg, snapshot },
    preloadedOnly: true,
    catalogProjector: projectorFor(cfg, snapshot, extra, provider),
  } satisfies Parameters<typeof prepareModelsListResult>[0];
  return { params, loadGatewayModelCatalogSnapshot };
}

it.each([false, true, "revoked"] as const)(
  "indexes configured rows once while projecting several logical models (auth rejects: %s)",
  async (rejectAuth) => {
    await withModelsListState(
      async (state) => {
        const provider = "projection-fixture";
        const authFailure = new Error("Configured auth read rejected");
        let rejectAuthReads = false;
        const readAuth = vi.fn(() => {
          if (rejectAuthReads) {
            throw authFailure;
          }
          return undefined;
        });
        const configuredRowVisits = new Map<ModelDefinitionConfig, number>();
        const models = Array.from({ length: 17 }, (_, index): ModelDefinitionConfig => ({
          id: `model-${index}`,
          name: `Configured ${index}`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          contextTokens: 16_000 + index,
          maxTokens: 4096,
        }));
        const configuredModels = new Proxy(models, {
          get(target, key, receiver) {
            if (key === Symbol.iterator) {
              return function* () {
                for (const model of target) {
                  configuredRowVisits.set(model, (configuredRowVisits.get(model) ?? 0) + 1);
                  yield model;
                }
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
        const selectedIndexes = [0, 4, 8, 12, 16];
        const entries: ModelCatalogEntry[] = selectedIndexes.map((index) => ({
          provider,
          id: `model-${index}`,
          name: `Catalog ${index}`,
          contextWindow: 8192,
          contextTokens: 2048,
        }));
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/model-0` } },
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://models.example.test/v1",
                models: configuredModels,
                get apiKey() {
                  return readAuth();
                },
              },
            },
          },
        };
        const projector = projectorFor(cfg, { entries, routeVariants: entries }, {}, provider);
        // Auth scope preparation visits configured models before projection begins.
        const visitsAfterConstruction = new Map(configuredRowVisits);
        if (rejectAuth === "revoked") {
          const entered = createDeferred();
          const release = createDeferred();
          const revoked = new Error("Session changed before private auth evaluation");
          let current = true;
          readAuth.mockClear();
          const preparation = projector.projectCatalog({
            withCurrent: async <T>(consume: () => T): Promise<Awaited<T>> => {
              entered.resolve();
              await release.promise;
              if (!current) {
                throw revoked;
              }
              return await consume();
            },
          });
          void preparation.catch(() => {});
          try {
            await awaitGateBeforeSettlement(
              entered.promise,
              preparation,
              "Catalog bypassed authority",
            );
            current = false;
            release.resolve();
            await expect(preparation).rejects.toBe(revoked);
            expect(readAuth).not.toHaveBeenCalled();
          } finally {
            release.resolve();
            await preparation.catch(() => {});
          }
          return;
        }
        rejectAuthReads = rejectAuth;
        if (rejectAuth) {
          await expect(projector.projectCatalog()).rejects.toBe(authFailure);
          expect(configuredRowVisits).toEqual(visitsAfterConstruction);
          return;
        }
        const projected = await projector.projectCatalog();
        expect(projected).toMatchObject(
          selectedIndexes.map((index) => ({
            name: `Configured ${index}`,
            contextWindow: 32_000,
            contextTokens: 16_000 + index,
          })),
        );
        for (const [model, visits] of configuredRowVisits) {
          expect(visits - (visitsAfterConstruction.get(model) ?? 0)).toBeLessThanOrEqual(1);
        }
        const visitsAfterProjection = new Map(configuredRowVisits);
        expect(await projector.projectCatalog()).toBe(projected);
        expect(configuredRowVisits).toEqual(visitsAfterProjection);
      },
      { agentEnv: "main" },
    );
  },
);

it.each([true, false])(
  "isolates an OpenClaw alternative from native-first metadata (host donor: %s)",
  async (hostDonor) => {
    await withModelsListState(
      async (state) => {
        const provider = "picker-fixture";
        const nativeRuntime = "picker-native";
        const cfg = pickerConfig(
          state.workspaceDir,
          `${provider}/model`,
          nativeRuntime,
          ["openclaw"],
          {
            allow: [`${provider}/manual`],
          },
        );
        const host = modelEntry(provider);
        const native = nativeModel(host, nativeRuntime, "native-only");
        const snapshot: ModelCatalogSnapshot = {
          entries: [native],
          routeVariants: [native, ...(hostDonor ? [host] : [])],
        };
        const pluginRegistry = registryFor(nativeRuntime);
        const { params: listParams, loadGatewayModelCatalogSnapshot } = preparePicker(
          cfg,
          snapshot,
          { pluginRegistry },
          provider,
        );
        const prepared = await prepareModelsListResult(listParams);
        const row = prepared.read().models.find((entry) => entry.id === "model");
        expect(row).toMatchObject({
          id: "model",
          provider,
          agentRuntime: { id: nativeRuntime },
          contextWindow: 128_000,
        });
        expect(row?.runtimeChoices).toHaveLength(1);
        const choice = row?.runtimeChoices?.[0];
        expect(choice).toMatchObject({ agentRuntime: { id: "openclaw" }, available: true });
        if (hostDonor) {
          expect(choice).toMatchObject({
            contextWindow: 32_000,
            reasoning: false,
            input: ["text"],
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "ultra", label: "ultra" },
            ],
          });
        } else {
          expectMissing(choice, "contextWindow", "reasoning", "thinkingLevels", "input");
        }
        expectMissing(choice, "contextWindows", "contextWindowDefault");
        expect(row).not.toHaveProperty("manualSelectionAllowed");
        expect(choice).not.toHaveProperty("manualSelectionAllowed");
        const scoped = await prepareModelsListResult({
          ...listParams,
          includeManualSelection: true,
        });
        const scopedRow = scoped.read().models.find((entry) => entry.id === "model");
        expect(scopedRow).toMatchObject({ manualSelectionAllowed: false });
        expect(scopedRow?.runtimeChoices?.[0]).toMatchObject({
          agentRuntime: { id: "openclaw" },
          available: true,
          manualSelectionAllowed: false,
        });
        expect(Value.Check(ModelChoiceSchema, scopedRow)).toBe(true);
        expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      },
      { agentEnv: "main" },
    );
  },
);

it.each([
  ["openai", "codex", "codex", "ready"],
  ["openai", "agentsapi", undefined, "ready"],
  ["openai", "codex", undefined, "missing"],
  ["openai", "codex", undefined, "throws"],
  ["picker-fixture", "codex", undefined, "ready"],
] as const)(
  "keeps %s/%s capabilities with session runtime %s and readiness %s",
  async (provider, runtime, runtimeOverride, initialReadiness) => {
    await withModelsListState(
      async (state) => {
        const model = "gpt-5.6-sol";
        const selectable = provider === "openai";
        const cfg = pickerConfig(state.workspaceDir, `${provider}/${model}`, "openclaw", [
          "openclaw",
          runtime,
          runtime,
          "missing-runtime",
        ]);
        const base = modelEntry(provider, { id: model });
        const native: ModelCatalogEntry = {
          ...nativeModel(base, runtime, "large"),
          contextTokens: 96_000,
          compat: {
            supportsTools: true,
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["low", "high"],
          },
          thinkingLevelMap: { off: null, low: "low", high: "high" },
        };
        const snapshot: ModelCatalogSnapshot = {
          entries: [base],
          routeVariants: [base, native],
        };
        let readiness = initialReadiness;
        const loadModelCatalog = vi.fn(async () => [native]);
        const pluginRegistry = registryFor(runtime, {
          workspaceEnvironment:
            runtime === "agentsapi"
              ? { kind: "provider-hosted", label: "Hosted fixture" }
              : undefined,
          authBootstrap: "harness",
          loadModelCatalog,
          readModelCatalogReadiness: () => {
            if (readiness === "throws") {
              throw new Error("Native catalog observation failed");
            }
            return readiness === "ready" ? { accountType: "chatgpt" } : undefined;
          },
        });
        const { params, loadGatewayModelCatalogSnapshot } = preparePicker(cfg, snapshot, {
          pluginRegistry,
          ...(runtimeOverride ? { runtimeOverride, profileProvider: provider } : {}),
        });
        const prepared = await prepareModelsListResult(params);
        const rows = prepared.read().models;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          provider,
          id: model,
          name: "Shared Model",
          agentRuntime: { id: "openclaw" },
        });
        expect(rows[0]?.runtimeChoices?.map((choice) => choice.agentRuntime.id)).toEqual([
          runtime,
          "missing-runtime",
        ]);
        const nativeChoice = rows[0]?.runtimeChoices?.[0];
        if (runtime === "agentsapi") {
          expect(nativeChoice?.agentRuntime).toMatchObject({
            workspaceEnvironment: { kind: "provider-hosted", label: "Hosted fixture" },
            cloudPlacementSupported: false,
            devicePlacementSupported: false,
          });
        }
        if (selectable && initialReadiness === "ready") {
          expect(nativeChoice).toMatchObject({
            agentRuntime: { id: runtime },
            available: true,
            reasoning: true,
            contextWindow: 128_000,
            contextTokens: 96_000,
            contextWindows: [{ id: "large", label: "Large", contextWindow: 128_000 }],
            contextWindowDefault: "large",
            supportsTools: true,
            input: ["text", "image"],
          });
          const thinkingIds = nativeChoice?.thinkingLevels?.map(({ id }) => id);
          expect(thinkingIds).toEqual(expect.arrayContaining(["low", "high"]));
          expect(thinkingIds).not.toContain("off");
        } else {
          expect(nativeChoice).toMatchObject({ agentRuntime: { id: runtime } });
          expectUnavailable(nativeChoice, selectable);
          expectMissing(nativeChoice, "contextWindow", "thinkingLevels");
        }
        expect(rows[0]?.runtimeChoices?.[1]).toMatchObject({
          available: false,
          unavailableReason: "unsupported-runtime",
        });
        expectMissing(rows[0]?.runtimeChoices?.[1], "contextWindow", "thinkingLevels");
        expect(Value.Check(ModelChoiceSchema, rows[0])).toBe(true);
        readiness = "missing";
        const revokedChoice = prepared.read().models[0]?.runtimeChoices?.[0];
        expectUnavailable(revokedChoice, selectable);
        readiness = "ready";
        const recoveredChoice = prepared.read().models[0]?.runtimeChoices?.[0];
        expect(recoveredChoice?.available).toBe(selectable);
        if (selectable) {
          expect(recoveredChoice).toMatchObject({ contextWindow: 128_000, reasoning: true });
        }
        expect(loadModelCatalog).not.toHaveBeenCalled();
        expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(cfg.agents?.defaults?.models?.[`${provider}/${model}`]?.agentRuntime?.id).toBe(
          "openclaw",
        );
      },
      { agentEnv: "main", env: WITHOUT_OPENAI_ENV_AUTH },
    );
  },
);
