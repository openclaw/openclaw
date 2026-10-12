import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as providerPolicySurface from "../../plugins/provider-policy-surface.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as pluginScope from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import * as sessionReads from "../session-utils-store.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import * as modelsListResult from "./models-list-result.js";
import {
  createModelsListTestContext,
  catalogEntry,
  providerCatalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

it("serves the published model-list projection and replaces it with its metadata generation", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "model-list-projection-" },
    async (state) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "test/first", modelPolicy: { allow: ["test/*"] } },
        },
      };
      const pluginRegistry = createEmptyPluginRegistry();
      const catalog = Array.from({ length: 64 }, (_, index) =>
        providerCatalogEntry("test", index === 0 ? "first" : `model-${index}`),
      );
      const context = createModelsListTestContext({
        pluginRegistry,
        cfg: config,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        catalog,
      });
      let currentConfig = config;
      context.getRuntimeConfig = () => currentConfig;
      const params = { agentId: "main", view: "all" as const };
      const expected = await modelsListResult.buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params,
      });
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      let current = true;
      const owner: ReturnType<typeof createChatMetadataOwner> = {
        ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
        isCurrent: () => current,
        pluginRegistry,
        modelCatalog: { entries: catalog, routeVariants: catalog },
      };
      harness.setOwner(owner);
      context.readPreparedModelsList = harness.runtime.readModelsList;
      const snapshot = (await readPreparedCatalog(context, "main"))!;
      const unpreparedRead = vi.fn(async () => snapshot);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        readPrepared: unpreparedRead,
        loadDeferred: unpreparedRead,
      });
      const read = async () => {
        let result: unknown;
        await modelsHandlers["models.list"]!({
          req: { type: "req", id: "prepared", method: "models.list", params },
          params,
          context,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, value, error) => {
            if (!ok) {
              throw new Error(JSON.stringify(error));
            }
            result = value;
          },
        } satisfies GatewayRequestHandlerOptions);
        return result;
      };
      const prepareProjection = vi.spyOn(modelsListResult, "prepareModelsListResult");
      try {
        await harness.runtime.refresh();
        expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
        const enterPluginScope = vi.spyOn(pluginScope, "withPluginRuntimeRegistryScope");
        const resolvePolicy = vi.spyOn(
          providerPolicySurface,
          "resolveDirectBundledProviderPolicySurface",
        );
        const prepareStatement = vi.spyOn(DatabaseSync.prototype, "prepare");
        const executeStatement = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          expect(await Promise.all(Array.from({ length: 10 }, read))).toEqual(
            Array.from({ length: 10 }, () => expected),
          );
          expect(enterPluginScope).not.toHaveBeenCalled();
          expect(prepareStatement).not.toHaveBeenCalled();
          expect(executeStatement).not.toHaveBeenCalled();
          expect(unpreparedRead).not.toHaveBeenCalled();
          // One provider lookup per read is sufficient; prepared rows retain their identities.
          expect(resolvePolicy.mock.calls.length).toBeLessThanOrEqual(10);
        } finally {
          enterPluginScope.mockRestore();
          resolvePolicy.mockRestore();
          prepareStatement.mockRestore();
          executeStatement.mockRestore();
        }
        currentConfig = {
          ...config,
          ui: { seamColor: "#123456", prefs: { chatShowToolCalls: false } },
          meta: { lastTouchedVersion: "2026.10.11" },
        };
        setRuntimeConfigSnapshot(currentConfig, currentConfig);
        harness.setConfig(currentConfig);
        harness.setOwner({ ...owner, config: currentConfig });
        await harness.runtime.refresh();
        expect(await read()).toEqual(expected);
        expect(prepareProjection).toHaveBeenCalledOnce();
        owner.modelCatalog.pendingProviders = ["test"];
        expect(await read()).toMatchObject({ pendingProviders: ["test"] });
        owner.modelCatalog.pendingProviders = undefined;
        owner.modelCatalog.refreshFailed = true;
        expect(await read()).toMatchObject({ refreshFailed: true });
        expect(await read()).not.toHaveProperty("pendingProviders");
        expect(prepareProjection).toHaveBeenCalledOnce();
        current = false;
        await expect(read()).rejects.toThrow("Model catalog changed while preparing this result");
        const replacement = {
          ...createChatMetadataOwner(currentConfig, "second", {}, "test", "openai-completions"),
          pluginRegistry,
        };
        harness.setOwner(replacement);
        await harness.runtime.refresh();
        expect(await read()).toMatchObject({
          models: expect.arrayContaining([expect.objectContaining({ id: "second" })]),
        });
        await Promise.all(Array.from({ length: 8 }, read));
        expect(prepareProjection).toHaveBeenCalledTimes(2);
        expect(unpreparedRead).not.toHaveBeenCalled();
      } finally {
        prepareProjection.mockRestore();
        await harness.runtime.stop();
        clearRuntimeConfigSnapshot();
      }
    },
  );
});

it("bounds saved-session reads while projecting configured models and runtime choices", async () => {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "session-model-list-reads-",
      agentEnv: "main",
      env: WITHOUT_OPENAI_ENV_AUTH,
    },
    async (state) => {
      const catalog = Array.from({ length: 9 }, (_, index) =>
        catalogEntry(`gpt-fixture-${index}`, "openai-responses"),
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            model: {
              primary: "openai/gpt-fixture-0",
              fallbacks: catalog.slice(1).map(({ id }) => `openai/${id}`),
            },
            models: Object.fromEntries(
              catalog.map(({ id }, index) => [
                `openai/${id}`,
                {
                  agentRuntime: { id: "openclaw" },
                  ...(index < 3 ? { pickerRuntimes: ["codex"] } : {}),
                },
              ]),
            ),
          },
        },
        auth: {
          profiles: {
            "openai:fixture": { provider: "openai", mode: "api_key" },
            "openai:alternate": { provider: "openai", mode: "api_key" },
          },
        },
        plugins: { entries: { codex: { enabled: true } } },
      };
      await state.writeConfig(config);
      const sessionKey = "agent:main:catalog-reader";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "catalog-reader",
          updatedAt: 1,
          authProfileOverride: "openai:fixture",
          authProfileOverrideSource: "user",
        },
      );
      const siblingSessionKey = "agent:main:catalog-sibling";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: siblingSessionKey },
        {
          sessionId: "catalog-sibling",
          updatedAt: 1,
          authProfileOverride: "openai:fixture",
          authProfileOverrideSource: "user",
        },
      );
      const pluginRegistry = createEmptyPluginRegistry();
      const loadNativeCatalog = vi.fn(async () => catalog);
      pluginRegistry.agentHarnesses.push({
        pluginId: "codex",
        source: "test",
        harness: {
          id: "codex",
          label: "Catalog fixture",
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("Model listing must not run inference");
          },
          loadModelCatalog: loadNativeCatalog,
          readModelCatalogReadiness: () => ({ accountType: "apiKey", authMode: "api_key" }),
        },
      });
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:fixture": { type: "api_key", provider: "openai", key: "synthetic-test-key" },
          "openai:alternate": { type: "api_key", provider: "openai", key: "synthetic-other-key" },
        },
      };
      const context = createModelsListTestContext({
        cfg: config,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        catalog,
        catalogComplete: true,
        pluginRegistry,
        preparedAuthStore: authStore,
      });
      const published = (await readPreparedCatalog(context, "main"))!;
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      const owner: ReturnType<typeof createChatMetadataOwner> = {
        ...createChatMetadataOwner(
          config,
          "gpt-fixture-0",
          { openai: { type: "api_key", key: "synthetic-test-key" } },
          "openai",
          "openai-responses",
        ),
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        catalogOwner: { agentId: "main", workspaceDir: state.workspaceDir },
        metadataSnapshot: published.metadataSnapshot,
        pluginRegistry,
        modelCatalog: { entries: catalog, routeVariants: catalog },
      };
      bindPreparedModelRuntimeAuth(owner, { store: authStore });
      harness.setOwner(owner);
      harness.setAuthStore(authStore);
      context.readPreparedModelsList = harness.runtime.readModelsList;
      const params = { agentId: "main", sessionKey, view: "configured" as const };
      const read = async () => {
        let result: ModelsListResult | undefined;
        await modelsHandlers["models.list"]!({
          req: { type: "req", id: "session-models", method: "models.list", params },
          params,
          context,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, value, error) => {
            if (!ok) {
              throw new Error(JSON.stringify(error));
            }
            result = value as ModelsListResult;
          },
        } satisfies GatewayRequestHandlerOptions);
        return result;
      };
      const sessionRead = vi.spyOn(sessionReads, "withGatewaySessionEntry");
      const prepareProjection = vi.spyOn(modelsListResult, "prepareModelsListResult");
      try {
        await harness.runtime.refresh();
        const result = await read();
        expect(result?.models).toHaveLength(9);
        expect(result?.models.every((model) => model.available)).toBe(true);
        expect(result?.models.filter((model) => model.runtimeChoices?.length)).toHaveLength(3);
        expect(result?.models.flatMap((model) => model.runtimeChoices ?? [])).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({ agentRuntime: expect.objectContaining({ id: "codex" }) }),
          ),
        );
        const readsPerRequest = sessionRead.mock.calls.length;
        expect(result?.accountSelection).toMatchObject({
          kind: "shared",
          authProfileId: "openai:fixture",
          source: "user",
        });
        sessionRead.mockClear();
        expect(await read()).toEqual(result);
        const warmReadsPerRequest = sessionRead.mock.calls.length;
        expect(await Promise.all(Array.from({ length: 6 }, read))).toEqual(
          Array.from({ length: 6 }, () => result),
        );
        if (process.env.OPENCLAW_BENCH_MODELS_LIST === "1") {
          for (let warmup = 0; warmup < 5; warmup++) {
            await read();
          }
          sessionRead.mockClear();
          const durations: number[] = [];
          for (let batch = 0; batch < 20; batch++) {
            await Promise.all(
              Array.from({ length: 6 }, async () => {
                const started = performance.now();
                await read();
                durations.push(performance.now() - started);
              }),
            );
          }
          durations.sort((left, right) => left - right);
          console.log(
            JSON.stringify({
              benchmark: "models.list",
              callers: 6,
              requests: durations.length,
              sessionReads: sessionRead.mock.calls.length,
              readsPerRequest,
              warmReadsPerRequest,
              p50Ms: durations[Math.floor(durations.length * 0.5)],
              p99Ms: durations[Math.ceil(durations.length * 0.99) - 1],
            }),
          );
        }
        expect(loadNativeCatalog).not.toHaveBeenCalled();
        // Model/runtime cardinality must not multiply live session authority acquisitions.
        expect(readsPerRequest).toBeLessThanOrEqual(12);
        expect(warmReadsPerRequest).toBeLessThanOrEqual(2);
        expect(prepareProjection).toHaveBeenCalledOnce();

        params.sessionKey = siblingSessionKey;
        expect(await read()).toMatchObject({
          models: result?.models,
          accountSelection: result?.accountSelection,
        });
        expect(prepareProjection).toHaveBeenCalledOnce();
        params.sessionKey = sessionKey;

        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            providerOverride: "openai",
            modelOverride: "gpt-fixture-8",
            modelOverrideRouteResolution: "resolved",
            agentRuntimeOverride: "codex",
            authProfileOverride: "openai:alternate",
          },
        );
        const changed = await Promise.all(Array.from({ length: 6 }, read));
        for (const projection of changed) {
          expect(projection?.models[0]).toMatchObject({
            id: "gpt-fixture-8",
            agentRuntime: { id: "codex" },
          });
          expect(projection?.accountSelection).toMatchObject({
            kind: "shared",
            authProfileId: "openai:alternate",
            source: "user",
          });
        }
        expect(prepareProjection).toHaveBeenCalledTimes(2);
        expect(await read()).toEqual(changed[0]);
        expect(prepareProjection).toHaveBeenCalledTimes(2);
        params.sessionKey = siblingSessionKey;
        expect(await read()).toMatchObject({
          models: result?.models,
          accountSelection: result?.accountSelection,
        });
        expect(prepareProjection).toHaveBeenCalledTimes(2);
      } finally {
        sessionRead.mockRestore();
        prepareProjection.mockRestore();
        await harness.runtime.stop();
      }
    },
  );
});
