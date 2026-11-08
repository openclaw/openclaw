import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { apiKey, harnessRegistry } from "../../agents/model-catalog-fixtures.test-support.js";
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
import { authorizationClient } from "../server-methods.authorization.test-support.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import * as sessionReads from "../session-utils-store.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "../test-helpers.env.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import * as modelsListResult from "./models-list-result.js";
import {
  createModelsListTestContext,
  catalogEntry,
  providerCatalogEntry,
  requestModelsList,
} from "./models-list-result.openai-routes.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

function modelsReader(
  context: GatewayRequestHandlerOptions["context"],
  params: GatewayRequestHandlerOptions["params"],
  client: GatewayClient | null = null,
) {
  return async () => {
    const respond = await requestModelsList(context, params, client);
    const call = respond.mock.calls[0];
    if (call && !call[0]) {
      throw new Error(JSON.stringify(call[2]));
    }
    return call?.[1] as ModelsListResult | undefined;
  };
}

it("retains the model-list projection until its catalog facts change", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "model-list-projection-" },
    async (state) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "test/first", modelPolicy: { allow: ["test/*"] } },
        },
      };
      setRuntimeConfigSnapshot(config);
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
      const client = authorizationClient(
        "prepared",
        ["operator.read"],
        { internal: { syntheticClient: true } },
        { caps: ["model-selection-policy"] },
      );
      const expected = await modelsListResult.buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params,
        includeManualSelection: true,
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
      const read = modelsReader(context, params, client);
      const readCommands = () => harness.runtime.read({ agentId: "main", includeModels: false });
      const publishConfig = async (next: OpenClawConfig) => {
        currentConfig = next;
        setRuntimeConfigSnapshot(next, next);
        harness.setConfig(next);
        harness.setOwner({ ...owner, config: next });
        await harness.runtime.refresh();
      };
      try {
        using prepareProjection = vi.spyOn(modelsListResult, "prepareModelsListResult");
        await harness.runtime.refresh();
        expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
        await expect(readCommands()).resolves.toMatchObject({
          commands: [{ name: "command-1-1" }],
        });
        {
          using enterPluginScope = vi.spyOn(pluginScope, "withPluginRuntimeRegistryScope");
          using resolvePolicy = vi.spyOn(
            providerPolicySurface,
            "resolveDirectBundledProviderPolicySurface",
          );
          using prepareStatement = vi.spyOn(DatabaseSync.prototype, "prepare");
          using executeStatement = vi.spyOn(DatabaseSync.prototype, "exec");
          expect(await Promise.all(Array.from({ length: 10 }, read))).toEqual(
            Array.from({ length: 10 }, () => expected),
          );
          expect(enterPluginScope).not.toHaveBeenCalled();
          expect(prepareStatement).not.toHaveBeenCalled();
          expect(executeStatement).not.toHaveBeenCalled();
          expect(unpreparedRead).not.toHaveBeenCalled();
          // One provider lookup per read is sufficient; prepared rows retain their identities.
          expect(resolvePolicy.mock.calls.length).toBeLessThanOrEqual(10);
        }
        harness.setSkillsVersion(2);
        await publishConfig({
          ...config,
          ui: { seamColor: "#123456", prefs: { chatShowToolCalls: false } },
          meta: { lastTouchedVersion: "2026.10.11" },
        });
        await expect(readCommands()).resolves.toMatchObject({
          commands: [{ name: "command-2-1" }],
        });
        expect(harness.buildCommands).toHaveBeenCalledTimes(2);
        expect(await read()).toEqual(expected);
        expect(prepareProjection).toHaveBeenCalledOnce();
        harness.setSkillsVersion(2);
        await harness.runtime.refresh();
        expect(await read()).toEqual(expected);
        expect(prepareProjection).toHaveBeenCalledOnce();
        expect(await readCommands()).toMatchObject({ commands: [{ name: "command-2-1" }] });
        owner.modelCatalog.pendingProviders = ["test"];
        expect(await read()).toMatchObject({ pendingProviders: ["test"] });
        owner.modelCatalog.pendingProviders = undefined;
        owner.modelCatalog.refreshFailed = true;
        expect(await read()).toMatchObject({ refreshFailed: true });
        expect(await read()).not.toHaveProperty("pendingProviders");
        expect(prepareProjection).toHaveBeenCalledOnce();
        await publishConfig({
          ...currentConfig,
          agents: {
            ...currentConfig.agents,
            defaults: {
              ...currentConfig.agents?.defaults,
              modelPolicy: { allow: ["test/first"] },
            },
          },
        });
        expect(await read()).toMatchObject({
          models: expect.arrayContaining([
            expect.objectContaining({ id: "first", manualSelectionAllowed: true }),
            expect.objectContaining({ id: "model-1", manualSelectionAllowed: false }),
          ]),
        });
        expect(prepareProjection).toHaveBeenCalledTimes(2);
        current = false;
        // A retired owner keeps serving its last list until the replacement publishes.
        expect(await read()).toMatchObject({
          models: expect.arrayContaining([expect.objectContaining({ id: "first" })]),
        });
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
        expect(prepareProjection).toHaveBeenCalledTimes(3);
        expect(unpreparedRead).not.toHaveBeenCalled();
      } finally {
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
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:catalog-reader";
      const siblingSessionKey = "agent:main:catalog-sibling";
      for (const id of ["catalog-reader", "catalog-sibling"]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${id}` },
          {
            sessionId: id,
            updatedAt: 1,
            authProfileOverride: "openai:fixture",
            authProfileOverrideSource: "user",
          },
        );
      }
      const loadNativeCatalog = vi.fn(async () => catalog);
      const pluginRegistry = harnessRegistry("codex", {
        authBootstrap: "harness",
        loadModelCatalog: loadNativeCatalog,
        readModelCatalogReadiness: () => ({ accountType: "apiKey", authMode: "api_key" }),
      });
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:fixture": apiKey("openai", "synthetic-test-key"),
          "openai:alternate": apiKey("openai", "synthetic-other-key"),
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
      const read = modelsReader(context, params);
      try {
        using sessionRead = vi.spyOn(sessionReads, "withGatewaySessionEntry");
        using prepareProjection = vi.spyOn(modelsListResult, "prepareModelsListResult");
        await harness.runtime.refresh();
        const result = await read();
        expect({
          models: result?.models.length,
          available: result?.models.every((model) => model.available),
          withChoices: result?.models.filter((model) => model.runtimeChoices?.length).length,
          choices: result?.models.flatMap((model) => model.runtimeChoices ?? []),
          account: result?.accountSelection,
        }).toMatchObject({
          models: 9,
          available: true,
          withChoices: 3,
          choices: Array.from({ length: 3 }, () =>
            expect.objectContaining({ agentRuntime: expect.objectContaining({ id: "codex" }) }),
          ),
          account: { kind: "shared", authProfileId: "openai:fixture", source: "user" },
        });
        const readsPerRequest = sessionRead.mock.calls.length;
        sessionRead.mockClear();
        expect(await read()).toEqual(result);
        const warmReadsPerRequest = sessionRead.mock.calls.length;
        expect(await Promise.all(Array.from({ length: 6 }, read))).toEqual(
          Array.from({ length: 6 }, () => result),
        );
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
        await harness.runtime.stop();
      }
    },
  );
});
