import { performance } from "node:perf_hooks";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ModelChoiceSchema } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { dualRoutes, platformRoute } from "../../agents/model-auth-availability.test-support.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { buildConfiguredModelCatalog } from "../../agents/model-selection-shared.js";
import { applyModelDefaults } from "../../config/defaults.js";
import * as providerModelConfig from "../../config/model-provider-config.js";
import {
  captureRuntimeConfigWithSource,
  getRuntimeConfigCapture,
} from "../../config/runtime-config-capture-state.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "../test-helpers.env.js";
import { prepareModelsListResult } from "./models-list-result.js";
import {
  modelAuthStore,
  withModelsListState,
} from "./models-list-result.openai-routes.test-support.js";

function modelEntry(provider: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    provider,
    id: "model",
    name: "Shared Model",
    contextWindow: 32_000,
    reasoning: false,
    input: ["text"],
    ...extra,
  };
}
function modelDefinition(id: string, name = id, contextTokens = 16_000): ModelDefinitionConfig {
  return {
    id,
    name,
    contextTokens,
    reasoning: false,
    input: ["text"],
    contextWindow: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4_096,
  };
}
const thinkingCompat: ModelCatalogEntry["compat"] = {
  supportsTools: true,
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ["low", "high"],
};
function nativeModel(base: ModelCatalogEntry, nativeRuntime: string, windowId: string) {
  const label = windowId === "large" ? "Large" : "Native";
  return modelEntry(base.provider, {
    ...base,
    nativeRuntime,
    contextWindow: 128_000,
    reasoning: true,
    input: ["text", "image"],
    contextWindows: [{ id: windowId, label, contextWindow: 128_000 }],
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
  const logGateway = { debug: vi.fn() };
  const context = { getRuntimeConfig: () => cfg, loadGatewayModelCatalogSnapshot, logGateway };
  const params = {
    source: { kind: "gateway", context },
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
        const models = Array.from(Array<undefined>(17).keys(), (index) =>
          modelDefinition(`model-${index}`, `Configured ${index}`, 16_000 + index),
        );
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
        const providerConfig = {
          baseUrl: "https://models.example.test/v1",
          models: configuredModels,
          get apiKey() {
            return readAuth();
          },
        };
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/model-0` } },
          models: { providers: { [provider]: providerConfig } },
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

it("bounds configured-row indexing through hydrated implicit OpenAI picker reads", async () => {
  await withModelsListState(
    async (state) => {
      const { validateConfigObjectRaw } = await import("../../config/validation-core.js");
      const ids = ["model-0", "model-4", "model-8", "model-12", "model-16"];
      const parsed = validateConfigObjectRaw({
        agents: {
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            model: "openai/model-0",
            modelPolicy: { allow: ids.map((id) => "openai/" + id) },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:9/v1",
              apiKey: "synthetic-test-key",
              models: Array.from(Array<undefined>(17).keys(), (index) => ({
                id: "model-" + index,
                name: "Configured " + index,
              })),
            },
          },
        },
      });
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
      }
      const metadata = createPluginMetadataSnapshotFixture({ plugins: [] });
      const cfg = captureRuntimeConfigWithSource(
        applyModelDefaults(parsed.config, { manifestRegistry: metadata.manifestRegistry }),
        parsed.config,
      );
      const runtimeRows = cfg.models?.providers?.openai?.models;
      const sourceRows = getRuntimeConfigCapture(cfg)?.source.models?.providers?.openai?.models;
      if (!runtimeRows || !sourceRows) {
        throw new Error("OpenAI fixture omitted its captured runtime/source rows");
      }
      expect(runtimeRows).toHaveLength(17);
      expect(sourceRows[0]?.reasoning).toBeUndefined();
      expect(runtimeRows[0]).toMatchObject({ reasoning: false, input: ["text"] });
      expect(cfg.models?.providers?.openai?.api).toBeUndefined();
      expect(runtimeRows.every((row) => row.api === undefined && !row.agentRuntime)).toBe(true);
      const entries = buildConfiguredModelCatalog({ cfg, manifestPlugins: metadata }).filter(
        (entry) => ids.includes(entry.id),
      );
      expect(entries).toHaveLength(5);
      const merge = providerModelConfig.resolveMergedModelProviderModels;
      let indexedRows = 0;
      // Only exported-owner calls with this captured pair are witnessed; lexical calls are not.
      const witness: typeof merge = (input) => {
        const result = merge(input);
        if (input.models && (input.models === runtimeRows || input.models === sourceRows)) {
          indexedRows += input.models.length;
        }
        return result;
      };
      using indexing = vi.spyOn(providerModelConfig, "resolveMergedModelProviderModels");
      indexing.mockImplementation(witness);
      const { params, loadGatewayModelCatalogSnapshot } = preparePicker(
        cfg,
        { entries, routeVariants: entries },
        {},
      );
      const afterConstruction = indexedRows;
      expect(afterConstruction, "Missing canonical construction witness").toBeGreaterThanOrEqual(
        runtimeRows.length,
      );
      const prepared = await prepareModelsListResult({
        ...params,
        params: { ...params.params, includeDefaultModels: false },
      });
      const afterPreparation = indexedRows;
      const first = prepared.read();
      const afterFirstRead = indexedRows;
      expect(first.models.map(({ id }) => id).toSorted()).toEqual(ids.toSorted());
      for (const entry of entries) {
        expect(params.catalogProjector.evaluateEntry(entry, [entry])).toMatchObject({
          availability: true,
          evidence: "provider-config",
          selectedCredential: { source: "direct", provider: "openai", requirement: "api-key" },
          routeResolution: { kind: "routes", defaultRuntimeId: "openclaw" },
          selectedRoute: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            authRequirement: "api-key",
            runtimePolicy: { compatibleIds: ["openclaw"] },
          },
        });
      }
      for (const row of first.models) {
        expect(row).toMatchObject({
          provider: "openai",
          available: true,
          agentRuntime: { id: "openclaw", source: "implicit" },
        });
      }
      expect(prepared.read()).toEqual(first);
      expect(indexedRows).toBe(afterFirstRead);
      expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(
        afterFirstRead - afterConstruction,
        JSON.stringify({ afterConstruction, afterPreparation, afterFirstRead }),
      ).toBeLessThanOrEqual(runtimeRows.length);
    },
    {
      agentEnv: "main",
      env: {
        ...WITHOUT_OPENAI_ENV_AUTH,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUILD_PRIVATE_QA: undefined,
        OPENCLAW_QA_FORCE_RUNTIME: undefined,
      },
    },
  );
});

it.each([true, false])(
  "isolates an OpenClaw alternative from native-first metadata (host donor: %s)",
  async (hostDonor) => {
    await withModelsListState(
      async (state) => {
        const provider = "picker-fixture";
        const nativeRuntime = "picker-native";
        const ref = `${provider}/model`;
        const policy = { allow: [`${provider}/manual`] };
        const cfg = pickerConfig(state.workspaceDir, ref, nativeRuntime, ["openclaw"], policy);
        const host = modelEntry(provider);
        const native = nativeModel(host, nativeRuntime, "native-only");
        const snapshot: ModelCatalogSnapshot = {
          entries: [native],
          routeVariants: [native, ...(hostDonor ? [host] : [])],
        };
        const options = { pluginRegistry: registryFor(nativeRuntime) };
        const picker = preparePicker(cfg, snapshot, options, provider);
        const prepared = await prepareModelsListResult(picker.params);
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
          ...picker.params,
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
        expect(picker.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      },
      { agentEnv: "main" },
    );
  },
);

it.each(["alternatives", "base-only", "matching-base"] as const)(
  "projects global Settings harness readiness separately from the credential agent (%s)",
  async (scenario) => {
    await withModelsListState(
      async (state) => {
        const provider = "openai";
        const id = "gpt-5.6-sol";
        const ref = `${provider}/${id}`;
        const hasAlternatives = scenario === "alternatives";
        const scopedRuntime = scenario === "matching-base" ? "openclaw" : "codex";
        const runtimes = hasAlternatives ? ["codex"] : [];
        const cfg = pickerConfig(state.workspaceDir, ref, "openclaw", runtimes);
        const scoped = { agentRuntime: { id: scopedRuntime }, pickerRuntimes: ["agentsapi"] };
        cfg.agents!.entries = { main: { models: { [ref]: scoped } } };
        const base = modelEntry(provider, { id });
        const native = nativeModel(base, "codex", "large");
        const pluginRegistry = registryFor("codex", {
          authBootstrap: "harness",
          loadModelCatalog: async () => [native],
          readModelCatalogReadiness: () =>
            hasAlternatives ? { accountType: "chatgpt" } : undefined,
        });
        const snapshot = { entries: [base], routeVariants: [base, native] };
        const { params } = preparePicker(cfg, snapshot, { pluginRegistry }, provider);
        const configured = (await prepareModelsListResult(params)).read();
        const row = configured.models.find((model) => model.id === id);
        expect(row).toMatchObject({ agentRuntime: { id: scopedRuntime } });
        if (scenario === "matching-base") {
          expect(row).toMatchObject({ available: true });
          expect(row).not.toHaveProperty("defaultModelRuntimes");
        } else {
          expect(row?.defaultModelRuntimes).toMatchObject({
            base: { agentRuntime: { id: "openclaw" }, available: true },
            alternatives: hasAlternatives
              ? [{ agentRuntime: { id: "codex" }, available: true }]
              : [],
          });
        }
        expect(row?.runtimeChoices?.map(({ agentRuntime }) => agentRuntime.id)).toEqual([
          "agentsapi",
        ]);
        expect(Value.Check(ModelChoiceSchema, row)).toBe(true);

        const ordinary = await prepareModelsListResult({
          ...params,
          params: { ...params.params, includeDefaultModels: false },
        });
        const ordinaryRow = ordinary.read().models.find((model) => model.id === id);
        expect(ordinaryRow).toMatchObject({
          agentRuntime: { id: scopedRuntime },
          runtimeChoices: [{ agentRuntime: { id: "agentsapi" } }],
        });
        expect(ordinaryRow).not.toHaveProperty("defaultModelRuntimes");
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
        const ref = `${provider}/${model}`;
        const runtimes = ["openclaw", runtime, runtime, "missing-runtime"];
        const cfg = pickerConfig(state.workspaceDir, ref, "openclaw", runtimes);
        const base = modelEntry(provider, { id: model });
        const native: ModelCatalogEntry = {
          ...nativeModel(base, runtime, "large"),
          contextTokens: 96_000,
          compat: thinkingCompat,
          thinkingLevelMap: { off: null, low: "low", high: "high" },
        };
        const snapshot = { entries: [base], routeVariants: [base, native] };
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
        expectUnavailable(prepared.read().models[0]?.runtimeChoices?.[0], selectable);
        readiness = "ready";
        const recoveredChoice = prepared.read().models[0]?.runtimeChoices?.[0];
        expect(recoveredChoice?.available).toBe(selectable);
        if (selectable) {
          expect(recoveredChoice).toMatchObject({ contextWindow: 128_000, reasoning: true });
        }
        expect(loadModelCatalog).not.toHaveBeenCalled();
        expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(cfg.agents?.defaults?.models?.[ref]?.agentRuntime?.id).toBe("openclaw");
      },
      { agentEnv: "main", env: WITHOUT_OPENAI_ENV_AUTH },
    );
  },
);

type ListParams = Parameters<typeof prepareModelsListResult>[0];
type ListView = NonNullable<ListParams["params"]["view"]>;
const views = ["default", "all", "configured", "provider-config"] as const;
const pickerState = { agentEnv: "main", env: WITHOUT_OPENAI_ENV_AUTH } as const;
const inPicker = (run: (dir: string) => Promise<void>) =>
  withModelsListState(({ workspaceDir }) => run(workspaceDir), pickerState);
function cooperativePicker(dir: string, view: ListView, onVisit?: (count: number) => void) {
  const { api, baseUrl } = platformRoute;
  const entries = Array.from(Array<undefined>(12).keys(), (index) =>
    modelEntry("openai", { id: `fixture-${index}`, api, baseUrl }),
  );
  const cfg = pickerConfig(dir, "openai/fixture-0", "openclaw", []);
  const models = Object.fromEntries(entries.map(({ id }) => [`openai/${id}`, {}]));
  const openai = { api, baseUrl, models: entries.map(({ id }) => modelDefinition(id)) };
  cfg.agents!.defaults!.models = models;
  cfg.models = { providers: { openai } };
  const visited = new Set<string>();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => visited.size * 9);
  onTestFinished(() => clock.mockRestore());
  const routeResolverFactory: NonNullable<ListParams["routeResolverFactory"]> =
    () =>
    ({ modelId }) => {
      if (modelId && !visited.has(modelId)) {
        visited.add(modelId);
        onVisit?.(visited.size);
      }
      return dualRoutes;
    };
  const snapshot = { entries, routeVariants: entries };
  const { params } = preparePicker(cfg, snapshot, { routeResolverFactory }, "openai");
  const request = { ...params.params, view, includeDefaultModels: false };
  return { params: { ...params, routeResolverFactory, params: request }, visited };
}
const draft = (assertCurrent: () => void) => ({
  agentId: "main",
  draftAccountSelection: { authProfileId: "openai:test", owner: "fixture", assertCurrent },
});
const fallback = { supported: false, fallbackRuntime: "openclaw" } as const;
const revocations = views.flatMap((view) =>
  ["draft", "publication"].map((source) => ({ view, source })),
);
describe("cooperative models list preparation regressions", () => {
  it.each(views)("slices %s with bounded authority", (view) =>
    inPicker(async (dir) => {
      const { params, visited } = cooperativePicker(dir, view);
      let wrapperEntries = 0,
        interleaved = 0;
      async function withCurrent<T>(consume: () => T): Promise<Awaited<T>> {
        wrapperEntries++;
        return await consume();
      }
      const probe = (async () => {
        for (let tick = 0; tick < 12; tick += 1) {
          await nextImmediate();
          interleaved += Number(visited.size > 0 && visited.size < 12);
        }
      })();
      onTestFinished(() => probe);
      const preparationAuthority = { withCurrent, assertCurrent() {} };
      const { read } = await prepareModelsListResult({ ...params, preparationAuthority });
      expect([visited.size, read().models.length]).toEqual([12, 12]);
      expect(interleaved).toBeGreaterThanOrEqual(3);
      expect(wrapperEntries).toBeLessThanOrEqual(6);
    }),
  );
  it.each(revocations)("stops $view when its $source scope revokes", ({ view, source }) =>
    inPicker(async (dir) => {
      const revoked = new Error("Fixture scope revoked");
      const assertCurrent = vi.fn();
      const { params, visited } = cooperativePicker(dir, view, (count) => {
        if (count === 3) {
          const pending = nextImmediate().then(() => {
            assertCurrent.mockImplementation(() => {
              throw revoked;
            });
          });
          onTestFinished(() => pending);
        }
      });
      const scope =
        source === "draft"
          ? { readScope: draft(assertCurrent) }
          : { publicationScope: { assertCurrent } };
      const prep = { ...params, ...scope, preparationAuthority: { assertCurrent() {} } };
      await expect(prepareModelsListResult(prep)).rejects.toBe(revoked);
      expect(visited.size).toBe(3);
    }),
  );
  it("reads the main row's live harness fallback", () =>
    inPicker(async (dir) => {
      const base = modelEntry("openai", { id: "gpt-5.6-sol", nativeRuntime: "codex" });
      const cfg = pickerConfig(dir, `openai/${base.id}`, "codex", ["openclaw", "codex"]);
      let supported = true;
      const supports = () => (supported ? { supported: true as const } : fallback);
      const pluginRegistry = registryFor("codex", { supports });
      const catalog = { entries: [base], routeVariants: [base] };
      const { params } = preparePicker(cfg, catalog, { pluginRegistry }, "openai");
      const { read } = await prepareModelsListResult(params);
      const sequence = [true, false, true].map((value) => {
        supported = value;
        const row = read().models[0];
        const pairs = row?.runtimeChoices?.map((c) => [c.agentRuntime.id, c.available]);
        const preview = row?.defaultModelRuntimes;
        expect(preview?.base.agentRuntime.id).toBe(row?.agentRuntime?.id);
        expect(preview?.alternatives.map((c) => [c.agentRuntime.id, c.available])).toEqual(pairs);
        return [row?.agentRuntime?.id, pairs];
      });
      expect(sequence).toEqual([
        ["codex", [["openclaw", true]]],
        ["openclaw", [["codex", false]]],
        ["codex", [["openclaw", true]]],
      ]);
    }));
});
describe("cooperative models list preparation compatibility invariants", () => {
  it.each([
    ["provider-config", "preparation"],
    ["all", "publication"],
  ] as const)("keeps %s synchronous with a %s wrapper", (view, wrapper) =>
    inPicker(async (dir) => {
      let inWrapper = false;
      const assertDraft = vi.fn(),
        visit = () => expect(inWrapper).toBe(true);
      const { params, visited } = cooperativePicker(dir, view, visit);
      async function withCurrent<T>(consume: () => T): Promise<Awaited<T>> {
        inWrapper = true;
        try {
          return await consume();
        } finally {
          inWrapper = false;
        }
      }
      const scope =
        wrapper === "preparation"
          ? { preparationAuthority: { withCurrent } }
          : { publicationScope: { withCurrent } };
      await prepareModelsListResult({ ...params, ...scope, readScope: draft(assertDraft) });
      expect(visited.size).toBe(12);
      expect(assertDraft).toHaveBeenCalled();
    }),
  );
  it.each([
    ["ordinary", 0],
    ["preview", 1],
    ["requested", 1],
    ["stacked", 2],
    ["provider-config", 1],
    ["pin", 0],
  ] as const)("%s preparation makes %i native readiness reads", (scenario, expected) =>
    inPicker(async (dir) => {
      const provider = "readiness-fixture",
        ref = `${provider}/model`;
      const stacked = scenario === "stacked",
        preview = stacked || scenario === "preview";
      const configured = scenario === "provider-config",
        pinned = scenario === "pin";
      const base = modelEntry(provider, { nativeRuntime: "codex" });
      const requested = scenario === "requested" ? ["openclaw"] : stacked ? ["codex"] : [];
      const cfg = pickerConfig(dir, ref, preview ? "openclaw" : "codex", requested);
      if (preview) {
        const pickerRuntimes = stacked ? ["openclaw"] : [];
        const scoped = { agentRuntime: { id: "codex" }, pickerRuntimes };
        cfg.agents!.entries = { main: { models: { [ref]: scoped } } };
      }
      cfg.agents!.defaults!.model = pinned ? `${ref}@${provider}:fixture` : ref;
      if (configured) {
        const models = [modelDefinition(base.id)];
        cfg.models = { providers: { [provider]: { baseUrl: "", models } } };
      }
      let readiness = "ready";
      const readModelCatalogReadiness = vi.fn(() => {
        if (readiness === "throws") {
          throw new Error("Fixture readiness error");
        }
        return readiness === "ready" ? { accountType: "chatgpt" as const } : undefined;
      });
      const registry = registryFor("codex", {
        authBootstrap: "harness",
        readModelCatalogReadiness,
      });
      const snapshot = { entries: [base], routeVariants: [base] };
      const isCurrent = () => readiness !== "revoked";
      const { params } = preparePicker(cfg, snapshot, { pluginRegistry: registry, isCurrent });
      const view: ListView = configured ? "provider-config" : "all";
      const request = { ...params.params, view, includeDefaultModels: preview };
      const { read } = await prepareModelsListResult({ ...params, params: request });
      expect(readModelCatalogReadiness).toHaveBeenCalledTimes(expected);
      const live = scenario === "ordinary" || configured;
      const states = live ? ["ready", "missing", "throws", "revoked"] : pinned ? ["ready"] : [];
      const observed = states.map((state) => {
        readiness = state;
        return read().models[0]?.available;
      });
      expect(observed).toEqual(live ? [true, false, false, false] : states.map(() => false));
      expect(readModelCatalogReadiness).toHaveBeenCalledTimes(expected + (live ? 3 : 0));
    }),
  );
  it("isolates base and native thinking levels", () =>
    inPicker(async (dir) => {
      const provider = "picker-fixture";
      const base = modelEntry(provider, {
        reasoning: true,
        compat: thinkingCompat,
        thinkingLevelMap: { off: null, low: "low", high: null },
      });
      const native = {
        ...nativeModel(base, "picker-native", "native-only"),
        thinkingLevelMap: { off: null, low: null, high: "high" },
      };
      const cfg = pickerConfig(dir, "picker-fixture/model", "picker-native", ["openclaw"]);
      const pluginRegistry = registryFor("picker-native");
      const catalog = { entries: [native], routeVariants: [native, base] };
      const { params } = preparePicker(cfg, catalog, { pluginRegistry }, provider);
      const { read } = await prepareModelsListResult(params);
      for (const {
        models: [row],
      } of [read(), read()]) {
        for (const [choice, present, absent] of [
          [row, "high", "low"],
          [row?.runtimeChoices?.[0], "low", "high"],
        ] as const) {
          const ids = choice?.thinkingLevels?.map(({ id }) => id);
          expect(ids).toContain(present);
          expect(ids).not.toContain(absent);
        }
      }
    }));
});
