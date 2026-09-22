import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { ModelChoiceSchema } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "../../agents/harness/model-catalog.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createGatewayAgentModelCatalogProjector,
  prepareModelsListResult,
} from "./models-list-result.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";

describe("models.list configured runtime choices", () => {
  it.each([false, true])(
    "indexes configured rows once while projecting several logical models (auth rejects: %s)",
    async (rejectAuth) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "model-projector-rows-", agentEnv: "main" },
        async (state) => {
          const provider = "projection-fixture";
          const authFailure = new Error("Configured auth read rejected");
          let rejectAuthReads = false;
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
                    if (rejectAuthReads) {
                      throw authFailure;
                    }
                    return undefined;
                  },
                },
              },
            },
          };
          const projector = createGatewayAgentModelCatalogProjector({
            cfg,
            agentId: "main",
            snapshot: { entries, routeVariants: entries },
            metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
            preparedAuthStore: {
              version: 1,
              profiles: {
                "projection-fixture:test": { type: "api_key", provider, key: "synthetic-test-key" },
              },
            },
          });
          // Auth scope preparation visits configured models before projection begins.
          const visitsAfterConstruction = new Map(configuredRowVisits);
          rejectAuthReads = rejectAuth;
          if (rejectAuth) {
            await expect(projector.projectCatalog()).rejects.toBe(authFailure);
            expect(configuredRowVisits).toEqual(visitsAfterConstruction);
            return;
          }
          const projected = await projector.projectCatalog();
          expect(
            projected.map(({ name, contextWindow, contextTokens }) => ({
              name,
              contextWindow,
              contextTokens,
            })),
          ).toEqual(
            selectedIndexes.map((index) => ({
              name: `Configured ${index}`,
              contextWindow: 32_000,
              contextTokens: 16_000 + index,
            })),
          );
          expect(
            Math.max(
              ...Array.from(
                configuredRowVisits,
                ([model, visits]) => visits - (visitsAfterConstruction.get(model) ?? 0),
              ),
            ),
          ).toBeLessThanOrEqual(1);
          const visitsAfterProjection = new Map(configuredRowVisits);
          expect(await projector.projectCatalog()).toBe(projected);
          expect(configuredRowVisits).toEqual(visitsAfterProjection);
        },
      );
    },
  );

  it.each([true, false])(
    "isolates an OpenClaw alternative from native-first metadata (host donor: %s)",
    async (hostDonor) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "model-picker-reverse-", agentEnv: "main" },
        async (state) => {
          const provider = "picker-fixture";
          const nativeRuntime = "picker-native";
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: `${provider}/model`,
                modelPolicy: { allow: [`${provider}/manual`] },
                models: {
                  [`${provider}/model`]: {
                    agentRuntime: { id: nativeRuntime },
                    pickerRuntimes: ["openclaw"],
                  },
                },
              },
            },
          };
          const host: ModelCatalogEntry = {
            provider,
            id: "model",
            name: "Shared Model",
            contextWindow: 32_000,
            reasoning: false,
            input: ["text"],
          };
          const native: ModelCatalogEntry = {
            ...host,
            nativeRuntime,
            contextWindow: 128_000,
            reasoning: true,
            input: ["text", "image"],
            contextWindows: [{ id: "native-only", label: "Native", contextWindow: 128_000 }],
            contextWindowDefault: "native-only",
          };
          const snapshot: ModelCatalogSnapshot = {
            entries: [native],
            routeVariants: [native, ...(hostDonor ? [host] : [])],
          };
          const pluginRegistry = createEmptyPluginRegistry();
          pluginRegistry.agentHarnesses.push({
            pluginId: nativeRuntime,
            source: "test",
            harness: {
              id: nativeRuntime,
              label: "Native fixture",
              supports: () => ({ supported: true }),
              runAttempt: vi.fn(),
            },
          });
          const projector = createGatewayAgentModelCatalogProjector({
            cfg,
            agentId: "main",
            snapshot,
            metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
            preparedAuthStore: {
              version: 1,
              profiles: {
                "picker-fixture:test": { type: "api_key", provider, key: "synthetic-test-key" },
              },
            },
            pluginRegistry,
          });
          const loadGatewayModelCatalogSnapshot = vi.fn();
          const listParams = {
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
            catalogProjector: projector,
          } satisfies Parameters<typeof prepareModelsListResult>[0];
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
              thinkingLevels: [{ id: "off", label: "off" }],
            });
          } else {
            expect(choice).not.toHaveProperty("contextWindow");
            expect(choice).not.toHaveProperty("reasoning");
            expect(choice).not.toHaveProperty("thinkingLevels");
            expect(choice).not.toHaveProperty("input");
          }
          expect(choice).not.toHaveProperty("contextWindows");
          expect(choice).not.toHaveProperty("contextWindowDefault");
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
      );
    },
  );

  it.each([
    {
      provider: "openai",
      runtime: "codex",
      runtimeOverride: undefined,
      initialReadiness: "ready",
      acquireNative: false,
    },
    {
      provider: "openai",
      runtime: "codex",
      runtimeOverride: "codex",
      initialReadiness: "ready",
      acquireNative: false,
    },
    {
      provider: "openai",
      runtime: "codex",
      runtimeOverride: undefined,
      initialReadiness: "missing",
      acquireNative: false,
    },
    {
      provider: "openai",
      runtime: "codex",
      runtimeOverride: undefined,
      initialReadiness: "throws",
      acquireNative: false,
    },
    {
      provider: "openai",
      runtime: "codex",
      runtimeOverride: undefined,
      initialReadiness: "ready",
      acquireNative: true,
    },
    {
      provider: "picker-fixture",
      runtime: "picker-native",
      runtimeOverride: undefined,
      initialReadiness: "ready",
      acquireNative: false,
    },
  ])(
    "keeps $runtime capabilities and selection availability with session runtime $runtimeOverride, readiness $initialReadiness, acquisition $acquireNative",
    async ({ provider, runtime, runtimeOverride, initialReadiness, acquireNative }) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "model-picker-runtimes-",
          agentEnv: "main",
          env: WITHOUT_OPENAI_ENV_AUTH,
        },
        async (state) => {
          const model = "gpt-5.6-sol";
          const selectable = provider === "openai";
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: `${provider}/${model}`,
                models: {
                  [`${provider}/${model}`]: {
                    agentRuntime: { id: "openclaw" },
                    pickerRuntimes: ["openclaw", runtime, runtime, "missing-runtime"],
                  },
                },
              },
            },
          };
          const base: ModelCatalogEntry = {
            provider,
            id: model,
            name: "Shared Model",
            reasoning: false,
            contextWindow: 32_000,
            input: ["text"],
          };
          const native: ModelCatalogEntry = {
            ...base,
            nativeRuntime: runtime,
            reasoning: true,
            contextWindow: 128_000,
            contextTokens: 96_000,
            contextWindows: [{ id: "large", label: "Large", contextWindow: 128_000 }],
            contextWindowDefault: "large",
            input: ["text", "image"],
            compat: {
              supportsTools: true,
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ["low", "high"],
            },
            thinkingLevelMap: { off: null, low: "low", high: "high" },
          };
          let snapshot: ModelCatalogSnapshot = {
            entries: [base],
            routeVariants: acquireNative ? [base] : [base, native],
          };
          let readiness = initialReadiness;
          let observed = !acquireNative;
          const loadModelCatalog = vi.fn(async () => {
            observed = true;
            return [native];
          });
          const harness: AgentHarnessV2 = {
            id: runtime,
            label: "Native fixture",
            authBootstrap: "harness",
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            loadModelCatalog,
            readModelCatalogReadiness: () => {
              if (readiness === "throws") {
                throw new Error("Native catalog observation failed");
              }
              return observed && readiness === "ready" ? { accountType: "chatgpt" } : undefined;
            },
          };
          const pluginRegistry = createEmptyPluginRegistry();
          pluginRegistry.agentHarnesses.push({ pluginId: runtime, source: "test", harness });
          if (acquireNative) {
            expect(
              harness.readModelCatalogReadiness?.({
                config: cfg,
                agentId: "main",
                agentDir: state.agentDir("main"),
                workspaceDir: state.workspaceDir,
                provider,
                modelId: model,
              }),
            ).toBeUndefined();
            snapshot = await augmentPreparedModelCatalogWithAgentHarness({
              input: {
                config: cfg,
                agentId: "main",
                agentDir: state.agentDir("main"),
                workspaceDir: state.workspaceDir,
              },
              snapshot,
              pluginRegistry,
            });
          }
          const projector = createGatewayAgentModelCatalogProjector({
            cfg,
            agentId: "main",
            snapshot,
            metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
            preparedAuthStore: { version: 1, profiles: {} },
            pluginRegistry,
            ...(runtimeOverride ? { runtimeOverride, profileProvider: provider } : {}),
          });
          const loadGatewayModelCatalogSnapshot = vi.fn();
          const prepared = await prepareModelsListResult({
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
            catalogProjector: projector,
          });
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
            expect(nativeChoice).toMatchObject({ agentRuntime: { id: runtime }, available: false });
            if (selectable) {
              expect(nativeChoice).not.toHaveProperty("unavailableReason");
            } else {
              expect(nativeChoice?.unavailableReason).toBe("unsupported-runtime");
            }
            expect(nativeChoice).not.toHaveProperty("contextWindow");
            expect(nativeChoice).not.toHaveProperty("thinkingLevels");
          }
          expect(rows[0]?.runtimeChoices?.[1]).toMatchObject({
            available: false,
            unavailableReason: "unsupported-runtime",
          });
          expect(rows[0]?.runtimeChoices?.[1]).not.toHaveProperty("contextWindow");
          expect(rows[0]?.runtimeChoices?.[1]).not.toHaveProperty("thinkingLevels");
          expect(Value.Check(ModelChoiceSchema, rows[0])).toBe(true);
          readiness = "missing";
          const revokedChoice = prepared.read().models[0]?.runtimeChoices?.[0];
          expect(revokedChoice?.available).toBe(false);
          if (selectable) {
            expect(revokedChoice).not.toHaveProperty("unavailableReason");
          } else {
            expect(revokedChoice?.unavailableReason).toBe("unsupported-runtime");
          }
          expect(loadModelCatalog).toHaveBeenCalledTimes(acquireNative ? 1 : 0);
          expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
          expect(cfg.agents?.defaults?.models?.[`${provider}/${model}`]?.agentRuntime?.id).toBe(
            "openclaw",
          );
        },
      );
    },
  );
});
