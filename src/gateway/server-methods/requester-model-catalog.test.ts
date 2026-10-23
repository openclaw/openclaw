import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as ownership from "../../agents/harness/session-runtime-ownership.js";
import { resolveOpenClawPluginToolsForOptions } from "../../agents/openclaw-plugin-tools.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { preparePluginToolExecutionCapabilities } from "../../agents/plugin-tool-execution.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import { copyPreparedModelRuntimeAuthBindings } from "../../agents/prepared-model-runtime-auth.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import { handlePluginCommand } from "../../auto-reply/reply/commands-plugin.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createFallbackSessionEntry } from "../../config/sessions/session-accessor.sqlite-normalize.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../../plugins/plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createPluginRequesterModels } from "../../plugins/requester-models.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../../plugins/runtime/load-context.resolve.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createChatMetadataOwner } from "./chat-metadata-runtime.test-support.js";
import {
  createModelsListTestContext,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import { projectRequesterModelCatalog } from "./requester-model-catalog-projection.js";
import type { GatewayClient, RespondFn } from "./types.js";

const ids = ["gpt-5.6-luna", "gpt-5.6-sol"];
afterEach(() => {
  vi.restoreAllMocks();
  setCurrentPluginMetadataSnapshot(undefined);
  resetPluginRuntimeStateForTest();
});

async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  missingAuth = false,
) {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prepareProfileCatalog: true,
      env: WITHOUT_OPENAI_ENV_AUTH,
      prefix: "requester-models-",
    },
    async () => {
      const f = await setup(missingAuth);
      using profiles = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      void profiles;
      await run(f);
    },
  );
}

async function setup(missingAuth = false) {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.6-luna",
        models: Object.fromEntries(ids.map((id) => ["openai/" + id, {}])),
      },
      entries: { main: {} },
    },
    gateway: {
      roles: {
        default: "luna",
        definitions: Object.fromEntries(
          ids.map((id, i) => [
            i ? "sol" : "luna",
            {
              agents: "*",
              scopes: ["operator.read"],
              sessions: { others: "none" },
              modelPolicy: { allow: ["openai/" + id] },
            },
          ]),
        ),
      },
    },
  };
  const accountCatalog = createPreparedAccountCatalogAccess(() => true, undefined, config);
  const owner = Object.assign(
    createChatMetadataOwner(
      config,
      ids[0]!,
      missingAuth ? {} : { openai: { type: "api_key", key: "synthetic-private-key" } },
      "openai",
      "openai-responses",
    ),
    { accountCatalog },
  );
  const refreshAccount = () =>
    accountCatalog.acquire({
      profileId: "openai:prepared",
      credential: { type: "api_key", provider: "openai", key: "synthetic-private-key" },
      allowDiscovery: true,
      refresh: true,
      load: async () => [],
    });
  await refreshAccount();
  owner.modelCatalog.entries.push({
    ...owner.modelCatalog.entries[0]!,
    id: ids[1]!,
    name: ids[1]!,
  });
  owner.modelCatalog.routeVariants!.push(owner.modelCatalog.entries[1]!);
  const context = createModelsListTestContext({
    cfg: config,
    catalog: owner.modelCatalog.entries,
    preparedAuthModes: owner.authModes,
    preparedAuthStore: {
      version: 1,
      profiles: missingAuth
        ? {}
        : {
            "openai:prepared": {
              type: "api_key",
              provider: "openai",
              key: "synthetic-private-key",
            },
          },
    },
    metadataSnapshot: owner.metadataSnapshot,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
  });
  const requesters = await Promise.all(
    ids.map(async (id, i) => {
      const person = ensureProfileForEmail((i ? "sol" : "luna") + "@example.test");
      setUserProfileRole(person.id, i ? "sol" : "luna");
      const sessionKey = "agent:main:" + person.id;
      const scope = { agentId: "main", sessionKey };
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const save = async (sessionId = sessionKey) => {
        const patch = {
          sessionId,
          updatedAt: 1,
          providerOverride: "openai",
          authProfileOverride: "openai:prepared",
          authProfileOverrideSource: "user" as const,
          createdActor: { type: "human" as const, source: "profile" as const, id: person.id },
        };
        await patchSessionEntryCore(scope, () => patch, {
          skipMaintenance: true,
          fallbackEntry: createFallbackSessionEntry(patch),
        });
      };
      await save();
      const policy = prepareOperatorModelPolicy({
        cfg: config,
        policy: { allow: ["openai/" + id] },
        manifestPlugins: owner.metadataSnapshot,
      });
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: person.id,
        scopes: ["operator.read"],
        modelPolicy: policy,
        assertCurrent() {
          if (!current) {
            throw new Error("Requester revoked");
          }
        },
      });
      const readerParams = {
        config,
        agentId: "main",
        sessionKey,
        sessionId: sessionKey,
        authority,
        preparedModelRuntime: owner,
        assertCurrent() {},
      };
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({
        id: "requester-catalog",
        source: "/plugins/requester-catalog/index.js",
        origin: "config",
        enabled: true,
        configSchema: true,
      });
      record.status = "loaded";
      registry.plugins.push(record);
      const toolContext = createPluginToolFactoryContext({
        registry,
        entry: {
          pluginId: record.id,
          source: record.source,
          names: ["catalog"],
          factory: () => null,
          contextVersion: 2,
          optional: false,
        },
        context: { sessionKey, sessionId: sessionKey, agentId: "main" },
        assertInvocationCurrent() {},
        bindExecutionCapabilities: preparePluginToolExecutionCapabilities(readerParams),
      }) as OpenClawPluginToolContext<2>;
      const models = toolContext.runtimeContext!.models!;
      const unpreparedModels = () =>
        createPluginRequesterModels({ ...readerParams, preparedModelRuntime: undefined })!;
      const client: GatewayClient = {
        connId: person.id,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: ["operator.read"],
          caps: [GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY],
        },
        authenticatedUserProfile: {
          profileId: person.id,
          displayName: person.displayName,
          hasAvatar: false,
          updatedAt: person.updatedAt,
        },
      };
      return {
        readerParams,
        models,
        unpreparedModels,
        save,
        revoke: () => {
          current = false;
        },
        async gateway() {
          const respond = vi.fn<RespondFn>();
          const params = { sessionKey, preparedOnly: true, includeDefaultModels: false };
          await modelsHandlers["models.list"]!({
            req: { type: "req", id: "requester-catalog", method: "models.list", params },
            params,
            context,
            client,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]![1] as ModelsListResult;
        },
      };
    }),
  );
  return { config, context, requesters, owner, accountCatalog, refreshAccount };
}

it("matches the safe models.list session projection for two differently restricted requesters", async () => {
  await fixture(async ({ requesters }) => {
    const catalogs = [];
    for (const [i, requester] of requesters.entries()) {
      const result = await requester.models.list();
      expect(result).toEqual(projectRequesterModelCatalog(await requester.gateway()));
      expect(result.models.map((model) => model.id)).toEqual([ids[i]]);
      expect(result.selectionPolicy).toEqual({
        restricted: true,
        defaultModel: "openai/" + ids[i],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-private-key|apiKeySupported|authProfile|credentials|refresh|family/,
      );
      catalogs.push(result);
    }
    expect(catalogs[0]!.revision).not.toBe(catalogs[1]!.revision);
  });
});

it.each(["native", "worker"] as const)(
  "admits the session model using %s-owned auth",
  async (auth) => {
    await fixture(async ({ config, requesters }) => {
      if (auth === "native") {
        vi.spyOn(ownership, "readSessionRuntimeOwnershipAsync").mockResolvedValue({
          model: "native",
          auth: "native",
          modelRef: { provider: "openai", model: ids[0]! },
        });
      } else {
        config.cloudWorkers = {
          requiredProfile: "dedicated",
          profiles: {
            dedicated: {
              provider: "device",
              settings: { device: "paired", inference: "worker" },
            },
          },
        };
        await patchSessionEntryCore(
          { agentId: "main", sessionKey: requesters[0]!.readerParams.sessionKey },
          () => ({
            authProfileOverride: undefined,
            authProfileOverrideSource: undefined,
          }),
          { skipMaintenance: true },
        );
        // External credential availability: no Gateway credential, but the worker owns inference.
      }
      const gateway = await requesters[0]!.gateway();
      expect(gateway.models.find((model) => model.id === ids[0])).not.toHaveProperty("available");
      const catalog = await requesters[0]!.models.list();
      expect(catalog.state).toBe("prepared");
      expect(catalog.models.map((model) => model.id)).toEqual([ids[0]]);
    }, auth === "worker");
  },
);

it("matches session model admission for the exact active worker placement", async () => {
  await fixture(async ({ context, requesters }) => {
    const requester = requesters[0]!;
    const { sessionId, sessionKey } = requester.readerParams;
    await patchSessionEntryCore(
      { agentId: "main", sessionKey },
      () => ({ authProfileOverride: undefined, authProfileOverrideSource: undefined }),
      { skipMaintenance: true },
    );
    const placement = {
      sessionId,
      sessionKey,
      agentId: "main",
      state: "active",
      executionMode: "worker-turn",
      environmentId: "device-environment",
      activeOwnerEpoch: 7,
      generation: 1,
      workspaceBaseManifestRef: "manifest",
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: "a".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
    } satisfies WorkerSessionPlacementRecord;
    const environment = {
      environmentId: placement.environmentId,
      ownerEpoch: 7,
      state: "attached",
      providerId: "device",
      profileId: "paired-device",
      nodeDeviceId: "paired-node",
      attachedSessionIds: [sessionId],
      inference: "worker",
    };
    const getMany = vi.fn(async () => new Map([[sessionId, placement]]));
    Object.assign(context, {
      workerSessionPlacementService: { getManyAsync: getMany },
      workerEnvironmentService: { get: () => environment, readMachineShape: () => undefined },
    });
    const models = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () => createPluginRequesterModels(requester.readerParams)!,
    );
    const gateway = await requester.gateway();
    expect(gateway.models.find((model) => model.id === ids[0])).not.toHaveProperty("available");
    expect((await models.list()).models.map((model) => model.id)).toEqual([ids[0]]);
    expect(getMany).toHaveBeenCalledTimes(2);
    // A detached/replaced environment cannot lend its worker-owned authentication.
    environment.ownerEpoch++;
    expect(projectRequesterModelCatalog(await requester.gateway()).models).toEqual([]);
    expect((await models.list()).models).toEqual([]);
  }, true);
});

it("recovers a retained reader after auth-owner replacement instead of pinning its retired owner", async () => {
  await fixture(async ({ config, requesters, owner }) => {
    const replacement = createChatMetadataOwner(
      config,
      ids[0]!,
      {
        openai: { type: "api_key", key: "synthetic-replacement-key" },
      },
      "openai",
      "openai-responses",
    );
    vi.spyOn(owner, "isCurrent").mockReturnValue(false);
    const published = vi
      .spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
      .mockReturnValue(undefined);
    await expect(requesters[0]!.models.list()).resolves.toMatchObject({
      state: "pending",
      models: [],
    });
    published.mockReturnValue(replacement);
    await expect(requesters[0]!.models.list()).resolves.toMatchObject({
      state: "prepared",
      models: [{ id: ids[0] }],
    });
  });
});

it("rejects an in-flight config change and retries against the new published config", async () => {
  await fixture(async ({ config, context, requesters, owner }) => {
    let currentConfig = config;
    context.getRuntimeConfig = () => currentConfig;
    const models = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () => createPluginRequesterModels(requesters[0]!.readerParams)!,
    );
    const original = ownership.readSessionRuntimeOwnershipAsync;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(ownership, "readSessionRuntimeOwnershipAsync").mockImplementationOnce(
      async (params) => {
        entered();
        await gate;
        return await original(params);
      },
    );
    const pending = models.list();
    void pending.catch(() => {});
    await awaitGateBeforeSettlement(started, pending, "Read did not enter native ownership");
    currentConfig = structuredClone(config);
    currentConfig.agents!.defaults!.models!["openai/" + ids[0]] = { alias: "Current config model" };
    vi.spyOn(owner, "isCurrent").mockReturnValue(false);
    const replacement = createChatMetadataOwner(
      currentConfig,
      ids[0]!,
      {
        openai: { type: "api_key", key: "synthetic-replacement-key" },
      },
      "openai",
      "openai-responses",
    );
    vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      replacement,
    );
    release();
    await expect(pending).rejects.toThrow("Requester config changed. Retry the request.");
    await expect(models.list()).resolves.toMatchObject({
      state: "prepared",
      models: [{ id: ids[0] }],
    });
  });
});

it("uses requester catalogs through the real command and agent tool assembly call sites", async () => {
  await fixture(async ({ config, owner, requesters }) => {
    const requester = requesters[0]!;
    config.plugins = { entries: { "catalog-test": { enabled: true } }, slots: { memory: "none" } };
    const workspaceDir = owner.catalogOwner!.workspaceDir;
    const artifact = {
      source: workspaceDir + "/catalog-plugin.js",
      rootDir: workspaceDir,
      origin: "bundled" as const,
      preferBuiltPluginArtifacts: false,
    };
    const record = createPluginRecord({
      id: "catalog-test",
      ...artifact,
      enabled: true,
      configSchema: true,
      contracts: { tools: ["catalog_probe"] },
    });
    record.status = "loaded";
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: record.id, ...artifact, enabledByDefault: true, contracts: record.contracts },
      ],
    });
    snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    snapshot.workspaceDir = workspaceDir;
    setCurrentPluginMetadataSnapshot(snapshot, { config, workspaceDir });
    const { registry, createApi } = createTestPluginRegistry(createPluginRuntime());
    setPluginRuntimeLoadContext(
      registry,
      resolvePluginRuntimeLoadContext({ config, workspaceDir, metadataSnapshot: snapshot }),
    );
    registry.plugins.push(record);
    const api = createApi(record, { config });
    runPluginRegisterSyncInRegistry(
      () => {
        api.registerCommand({
          name: "catalog",
          description: "Requester catalog",
          requireAuth: false,
          runtimeCapabilities: ["models"],
          async handler(ctx) {
            return {
              text: JSON.stringify((await ctx.runtimeContext?.models?.list()) ?? "unavailable"),
            };
          },
        });
        api.registerTool(
          {
            contextVersion: 2,
            create: (ctx) => ({
              name: "catalog_probe",
              label: "Catalog",
              description: "Requester catalog",
              parameters: { type: "object", properties: {} },
              async execute() {
                const catalog = await ctx.runtimeContext?.models?.list();
                return {
                  content: [{ type: "text", text: JSON.stringify(catalog ?? "unavailable") }],
                  details: catalog,
                };
              },
            }),
          },
          { name: "catalog_probe", workspaceAccess: false },
        );
      },
      api,
      registry,
      record.id,
    );
    setActivePluginRegistry(registry);
    const pluginOwner = { ...owner, pluginRegistry: registry, metadataSnapshot: snapshot };
    copyPreparedModelRuntimeAuthBindings(owner, pluginOwner);
    vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      pluginOwner,
    );
    try {
      expect(registry.diagnostics).toEqual([]);
      const expected = projectRequesterModelCatalog(await requester.gateway());
      const params = buildCommandTestParams("/catalog", config);
      params.sessionKey = requester.readerParams.sessionKey;
      params.sessionEntry = { sessionId: requester.readerParams.sessionId, updatedAt: 1 };
      params.opts = { operatorAuthority: requester.readerParams.authority };
      expect((await handlePluginCommand(params, true))?.reply?.text).toBe(JSON.stringify(expected));
      params.opts = {};
      expect((await handlePluginCommand(params, true))?.reply?.text).toBe(
        JSON.stringify("unavailable"),
      );
      for (const admitted of [true, false]) {
        const tools = resolveOpenClawPluginToolsForOptions({
          resolvedConfig: config,
          options: {
            config,
            workspaceDir,
            agentSessionKey: requester.readerParams.sessionKey,
            sessionId: requester.readerParams.sessionId,
            preparedModelRuntime: pluginOwner,
            pluginExecutionAuthority: admitted ? requester.readerParams.authority : undefined,
            assertInvocationCurrent: requester.readerParams.authority.assertCurrent,
            pluginToolAllowlist: ["catalog_probe"],
          },
        });
        expect(tools.map((tool) => tool.name)).toEqual(["catalog_probe"]);
        const result = await tools[0]!.execute("probe", {});
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(admitted ? expected : "unavailable") },
        ]);
      }
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  });
});

it("returns pending with no admitted models when no prepared owner is published", async () => {
  await fixture(async ({ requesters }) => {
    vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      undefined,
    );
    await expect(requesters[0]!.unpreparedModels().list()).resolves.toEqual({
      revision: expect.any(String),
      state: "pending",
      models: [],
      selectionPolicy: { restricted: true, defaultModel: null },
    });
  });
});

it.each(["reset", "revocation", "retirement", "account publication"])(
  "does not publish after %s during an awaited native-owner read",
  async (change) => {
    await fixture(async ({ requesters, owner, accountCatalog, refreshAccount }) => {
      const requester = requesters[0]!;
      const original = ownership.readSessionRuntimeOwnershipAsync;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(ownership, "readSessionRuntimeOwnershipAsync").mockImplementationOnce(
        async (params) => {
          entered();
          await gate;
          return await original(params);
        },
      );
      const isOwnerCurrent = vi.spyOn(owner, "isCurrent");
      const acquired = vi.spyOn(accountCatalog, "acquire");
      const pending = requester.models.list();
      void pending.catch(() => {});
      await awaitGateBeforeSettlement(
        started,
        pending,
        "Catalog bypassed native-owner preparation",
      );
      try {
        if (change === "reset") {
          await requester.save("replacement-session");
        }
        if (change === "revocation") {
          requester.revoke();
        }
        if (change === "retirement") {
          isOwnerCurrent.mockReturnValue(false);
        }
        if (change === "account publication") {
          expect(acquired).toHaveBeenCalledWith(
            expect.objectContaining({ profileId: "openai:prepared", allowDiscovery: false }),
          );
          await refreshAccount();
          expect(owner.isCurrent()).toBe(true);
        }
      } finally {
        release();
      }
      const reasons = {
        reset: "Session changed while preparing its metadata. Retry the request.",
        revocation: "Requester revoked",
        retirement: "Requester catalog owner changed.",
        "account publication": "Requester account catalog changed.",
      };
      await expect(pending).rejects.toThrow(reasons[change as keyof typeof reasons]);
    });
  },
);

it("never represents unknown, unavailable or non-selectable rows as available, and drops credential-bearing fields", () => {
  const catalog = projectRequesterModelCatalog({
    models: [
      {
        id: "ready",
        provider: "test",
        name: "Ready",
        available: true,
        apiKeySupported: true,
        thinkingLevels: [{ id: "high", label: "High" }],
        supportsFastMode: true,
      },
      {
        id: "no-fast",
        provider: "test",
        name: "No fast",
        available: true,
        supportsFastMode: false,
      },
      { id: "unknown", provider: "test", name: "Unknown" },
      { id: "offline", provider: "test", name: "Offline", available: false },
      {
        id: "hidden",
        provider: "test",
        name: "Hidden",
        available: true,
        manualSelectionAllowed: false,
      },
    ],
    pendingProviders: ["test"],
    accountSelection: {
      kind: "personal",
      label: "Private",
      authProfileId: "private-account",
      source: "user",
    },
  });
  expect(catalog).toEqual({
    revision: expect.any(String),
    state: "pending",
    models: [
      {
        id: "ready",
        provider: "test",
        name: "Ready",
        thinkingLevels: ["high"],
        fastModes: [false, true, "auto"],
      },
      { id: "no-fast", provider: "test", name: "No fast", fastModes: [false] },
    ],
  });
});
