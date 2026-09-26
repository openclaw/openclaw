// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeRuntimeAuthMaterializations } from "../agents/auth-profiles/runtime-materializations.js";
import { reportEmbeddedRunSuccessfulAuthBinding } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import type { EmbeddedRunAttemptResult } from "../agents/embedded-agent-runner/run/types.js";
import type { AgentHarnessV2 } from "../agents/harness/types.js";
import { getPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import {
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { createModelSelectionState } from "../auto-reply/reply/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { quiescePluginRegistry } from "../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  configureAuthFixture,
  configureHarnessOwnedUnresolvedAuth,
  model,
} from "./server-chat-metadata-lifecycle.auth.test-support.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
  prepareModelsListResult,
} from "./server-methods/models-list-result.js";
import { modelsHandlers } from "./server-methods/models.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { resolveGatewayModelSupportsImages } from "./session-utils-model.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;
const config = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": {} },
      modelPolicy: { allow: ["openai/gpt-5.4"] },
    },
    list: [{ id: "main", default: true }],
  },
} as OpenClawConfig;
const context = {
  broadcast: vi.fn(),
  getRuntimeConfig: () => config,
  logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as GatewayRequestContext;
let sidecars = createGatewaySidecarStopOwner();

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  await resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["main"];
  mocks.authStorage.getAll.mockReturnValue({
    openai: {
      type: "oauth",
      access: "prepared-access",
      refresh: "prepared-refresh",
      expires: Date.now() + 30 * 60_000,
    },
  });
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  sidecars = createGatewaySidecarStopOwner();
});

afterEach(async ({ task }) => {
  await sidecars.stop();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  vi.unstubAllEnvs();
});

async function createLifecycle(getConfig: () => OpenClawConfig = () => config) {
  return await createGatewayChatMetadataLifecycle({
    getConfig,
    minimalTestGateway: false,
    log: { warn: vi.fn() } as never,
  });
}

async function publishOwner(ownerConfig: OpenClawConfig = config): Promise<void> {
  await refreshPreparedModelRuntimeSnapshots(ownerConfig, {
    gatewayLifecycle: true,
    catalogMode: "live",
    allowGatewaySubagentBinding: true,
  });
}

function createCatalogContext(getConfig: () => OpenClawConfig) {
  const loader: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (params) =>
    loadGatewayModelCatalogSnapshot({ ...params, getConfig });
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: (params) => loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig }),
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig }),
  });
  return { ...context, getRuntimeConfig: getConfig, loadGatewayModelCatalogSnapshot: loader };
}

async function expectAvailable(
  lifecycle: Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>,
  expectedAvailable = true,
  activeConfig: OpenClawConfig = config,
  activeContext: GatewayRequestContext = context,
): Promise<void> {
  const owner = getPreparedModelCatalogOwnerSnapshot({
    agentId: "main",
    config: activeConfig,
    readOnly: true,
    allowGatewaySubagentBinding: true,
  });
  if (!owner) {
    throw new Error("expected prepared model owner");
  }
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: activeConfig,
    agentId: "main",
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: mocks.preparedAuthStore ?? { version: 1, profiles: {} },
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
  });
  const [metadata, modelsList] = await Promise.all([
    lifecycle.read({ agentId: "main" }),
    buildModelsListResult({
      source: { kind: "gateway", context: activeContext },
      agentId: "main",
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: "main",
        config: activeConfig,
        snapshot: owner.modelCatalog,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  const metadataModels = metadata.models as
    | Array<{ id?: string; provider?: string; available?: boolean }>
    | undefined;
  const metadataModel = metadataModels?.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  const listedModel = modelsList.models.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  expect({
    chatMetadata: metadataModel?.available,
    modelsList: listedModel?.available,
  }).toEqual({
    chatMetadata: expectedAvailable,
    modelsList: expectedAvailable,
  });
}

describe("gateway chat metadata lifecycle composition", () => {
  it.each([false, true])(
    "publishes coherent native membership when readiness changes from %s during preparation",
    async (initialReady) => {
      const nativeConfig: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            models: {
              "openai/*": { agentRuntime: { id: "native-test" } },
              "openai/gpt-5.6-luna": { agentRuntime: { id: "native-test" } },
            },
            modelPolicy: { allow: ["openai/*", "openai/gpt-5.6-luna"] },
          },
          list: [{ id: "main", default: true }],
        },
      };
      const rows = ["codex-latest", "gpt-5.6-luna"].map((id) => ({
        provider: "openai",
        id,
        name: id,
        nativeRuntime: "native-test",
      }));
      let ready = initialReady;
      const loadModelCatalog = vi.fn(async () => rows);
      const harness: AgentHarnessV2 = {
        id: "native-test",
        label: "Synthetic native harness",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog,
        readModelCatalogReadiness: () => (ready ? { accountType: "apiKey" } : undefined),
      };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({ pluginId: "native-test", source: "test", harness });
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(registry);
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.preparedAuthStore = { version: 1, profiles: {} };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: rows,
        routeVariants: rows,
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let result: ReturnType<typeof buildModelsListResult> | undefined;
      try {
        await publishOwner(nativeConfig);
        expect(loadModelCatalog).toHaveBeenCalled();
        loadModelCatalog.mockClear();
        const owner = getPreparedModelCatalogOwnerSnapshot({
          agentId: "main",
          config: nativeConfig,
          readOnly: true,
          allowGatewaySubagentBinding: true,
        });
        if (!owner) {
          throw new Error("expected prepared native model owner");
        }
        const projector = createGatewayAgentModelCatalogProjector({
          cfg: owner.config,
          agentId: "main",
          snapshot: owner.modelCatalog,
          metadataSnapshot: owner.metadataSnapshot,
          preparedAuthStore: mocks.preparedAuthStore,
          preparedRuntimeAuthModes: owner.authModes,
        });
        const evaluateEntry = projector.evaluateEntry;
        const evaluations = vi
          .spyOn(projector, "evaluateEntry")
          .mockImplementation(async (entry, variants) => {
            if (entry.id === "gpt-5.6-luna") {
              entered.resolve();
              await resume.promise;
            }
            return evaluateEntry(entry, variants);
          });
        const builds = mocks.buildPreparedModelCatalogSnapshot.mock.calls.length;
        const request: Parameters<typeof buildModelsListResult>[0] = {
          source: {
            kind: "gateway",
            context: { ...context, getRuntimeConfig: () => nativeConfig },
          },
          agentId: "main",
          params: { view: "configured", preparedOnly: true },
          preloadedOnly: true,
          preloadedCatalog: {
            agentId: "main",
            config: owner.config,
            snapshot: owner.modelCatalog,
          },
          catalogProjector: projector,
        };
        result = buildModelsListResult(request);
        await entered.promise;
        ready = !initialReady;
        resume.resolve();
        const models = (await result).models;
        expect(models.map(({ id }) => id).toSorted()).toEqual(
          ready ? ["codex-latest", "gpt-5.6-luna"] : ["gpt-5.6-luna"],
        );
        expect(models.every(({ available }) => available === ready)).toBe(true);
        expect(loadModelCatalog).not.toHaveBeenCalled();
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(builds);
        const prepared = await prepareModelsListResult(request);
        const hostCalls = evaluations.mock.calls.length;
        ready = initialReady;
        for (let read = 0; read < 3; read++) {
          expect(prepared.isCurrent()).toBe(true);
          const membership = prepared.read().models.map(({ id, available }) => [id, available]);
          expect(membership).toHaveLength(ready ? 2 : 1);
          expect(membership).toEqual(
            expect.arrayContaining(
              ready
                ? [
                    ["codex-latest", true],
                    ["gpt-5.6-luna", true],
                  ]
                : [["gpt-5.6-luna", false]],
            ),
          );
        }
        expect(evaluations).toHaveBeenCalledTimes(hostCalls);
        expect(loadModelCatalog).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await Promise.allSettled([result]);
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  it.each([
    { wildcard: false, invalidate: "dispose", authoritative: undefined },
    { wildcard: true, invalidate: "dispose", authoritative: undefined },
    { wildcard: false, invalidate: "registry", authoritative: undefined },
    { wildcard: false, invalidate: "stamp", authoritative: undefined },
    { wildcard: false, invalidate: "generation", authoritative: undefined },
    { wildcard: false, invalidate: "dispose", authoritative: true },
    { wildcard: false, invalidate: "dispose", authoritative: false },
  ])(
    "registered models.list preserves native metadata and pin authority after discovery (wildcard=$wildcard, $invalidate, authoritative=$authoritative)",
    async ({ wildcard, invalidate, authoritative }) => {
      const modelRef = wildcard ? "openai/*" : "openai/codex-latest";
      // Picker preparation discovers native catalogs even without a primary model.
      const nativeConfig: OpenClawConfig = {
        agents: {
          defaults: {
            models: { [modelRef]: { agentRuntime: { id: "native-test" } } },
            modelPolicy: { allow: [modelRef] },
          },
          list: [{ id: "main", default: true }],
        },
      };
      let currentConfig = nativeConfig;
      const readOwner = () =>
        getPreparedModelCatalogOwnerSnapshot({
          agentId: "main",
          config: currentConfig,
          readOnly: true,
          allowGatewaySubagentBinding: true,
        });
      const nativeModel = {
        provider: "openai",
        id: "codex-latest",
        name: "Codex (Latest)",
        reasoning: true,
        nativeRuntime: "native-test",
      };
      let revision = 0;
      let observedRevision: number | undefined;
      let disposed = false;
      const loadModelCatalog = vi.fn(async () => {
        observedRevision = revision;
        return [nativeModel];
      });
      const readModelCatalogReadiness = vi.fn<
        NonNullable<AgentHarnessV2["readModelCatalogReadiness"]>
      >((scope) => {
        expect(scope).toMatchObject({
          config: nativeConfig,
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          modelId: "codex-latest",
        });
        // Native observations retain their preparation identity across public config stamps.
        if (scope.config !== readOwner()?.observationConfig) {
          return undefined;
        }
        return !disposed && observedRevision === revision ? { accountType: "apiKey" } : undefined;
      });
      const harness: AgentHarnessV2 = {
        id: "native-test",
        label: "Synthetic native harness",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog,
        readModelCatalogReadiness,
      };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({ pluginId: "native-test", source: "test", harness });
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(registry);
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.preparedAuthStore = { version: 1, profiles: {} };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: [nativeModel],
        routeVariants: [nativeModel],
        authoritative,
      });
      const nativeContext = createCatalogContext(() => currentConfig);
      const loader = nativeContext.loadGatewayModelCatalogSnapshot;
      try {
        await publishOwner(nativeConfig);
        expect(loadModelCatalog).toHaveBeenCalled();
        const preparationCalls = loadModelCatalog.mock.calls.length;
        loadModelCatalog.mockClear();
        revision += 1;
        const lifecycle = await createLifecycle(() => currentConfig);
        await lifecycle.attachContext(nativeContext, sidecars.publish);
        const expectedModels = (available: boolean) =>
          wildcard && !available
            ? []
            : [
                expect.objectContaining({
                  id: "codex-latest",
                  name: "Codex (Latest)",
                  reasoning: true,
                  available,
                }),
              ];
        const owner = readOwner();
        if (!owner) {
          throw new Error("expected prepared native model owner");
        }
        const expectNativeAvailable = async (available: boolean) => {
          const expected = { models: expectedModels(available) };
          const params = { agentId: "main", view: "configured", preparedOnly: true };
          const respond = vi.fn();
          const handler = modelsHandlers["models.list"];
          if (!handler) {
            throw new Error("models.list handler missing");
          }
          await handler({
            req: { type: "req", id: "native-noop-models", method: "models.list", params },
            params,
            respond,
            client: null,
            isWebchatConnect: () => false,
            context: nativeContext,
          });
          expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(expected), undefined);
          await expect(lifecycle.read({ agentId: "main" })).resolves.toMatchObject(expected);
          const catalogs = await lifecycle.readStartup({ agentId: "main", readPolicy: "ready" });
          expect(catalogs?.sessionModelCatalog).toBe(catalogs?.defaultModelCatalog);
          expect(catalogs).not.toHaveProperty("metadata");
          await expect(lifecycle.readStartup({ agentId: "main" })).resolves.toMatchObject({
            metadata: expected,
          });
        };
        await expectNativeAvailable(false);
        const imageCatalogLoader = vi.fn(loader);
        await expect(
          resolveGatewayModelSupportsImages({
            agentId: "main",
            provider: "openai",
            model: "codex-latest",
            loadGatewayModelCatalog: async (params) => (await loader(params)).entries,
            loadGatewayModelCatalogSnapshot: imageCatalogLoader,
          }),
        ).resolves.toBe(false);
        expect(imageCatalogLoader.mock.calls).toEqual([[{ agentId: "main", readOnly: true }]]);
        if (!wildcard) {
          const sessionKey = "agent:main:telegram:direct:pin-authority";
          const sessionEntry: SessionEntry = {
            sessionId: "native-noop-pin",
            updatedAt: Date.now(),
            providerOverride: "openai",
            modelOverride: "account-model-unavailable",
            modelOverrideSource: "user",
          };
          const selection = await createModelSelectionState({
            cfg: currentConfig,
            agentId: "main",
            agentCfg: currentConfig.agents?.defaults,
            sessionEntry,
            sessionStore: { [sessionKey]: sessionEntry },
            sessionKey,
            defaultProvider: "openai",
            defaultModel: "codex-latest",
            provider: "openai",
            model: "codex-latest",
            hasModelDirective: true,
            preparedModelCatalog: await loader({ agentId: "main", readOnly: true }),
          });
          expect(selection).toMatchObject({
            model: "codex-latest",
            resetModelOverride: authoritative !== false,
            resetModelOverrideRef: "openai/account-model-unavailable",
            resetModelOverrideReason:
              authoritative === false ? "temporarily-unavailable" : "disallowed",
          });
          expect(sessionEntry.modelOverride).toBe(
            authoritative === false ? "account-model-unavailable" : undefined,
          );
          expect(sessionEntry.modelOverrideSource).toBe(
            authoritative === false ? "user" : undefined,
          );
        }
        expect(loadModelCatalog).not.toHaveBeenCalled();
        const builds = mocks.buildPreparedModelCatalogSnapshot.mock.calls.length;

        await loadModelCatalog();
        await lifecycle.refresh(); // Matching prepared/auth facts must not freeze the old boolean.
        await expectNativeAvailable(true);
        const lockedSession = {
          authProfileOverride: "openai:missing",
          authProfileOverrideSource: "user" as const,
        };
        await expect(
          lifecycle.readStartup({
            agentId: "main",
            sessionEntry: lockedSession,
            readPolicy: "ready",
          }),
        ).resolves.toBeUndefined();
        const lockedMetadata = await lifecycle.read({
          agentId: "main",
          sessionEntry: lockedSession,
        });
        expect(lockedMetadata).toMatchObject({
          models: wildcard
            ? []
            : [expect.objectContaining({ id: "codex-latest", available: false })],
        });
        const lockedStartup = await lifecycle.readStartup({
          agentId: "main",
          sessionEntry: lockedSession,
        });
        expect(lockedStartup?.metadata).toEqual(lockedMetadata);
        await expect(
          lifecycle.readStartup({
            agentId: "main",
            sessionEntry: lockedSession,
            readPolicy: "ready",
          }),
        ).resolves.toEqual({
          sessionModelCatalog: lockedStartup?.sessionModelCatalog,
          defaultModelCatalog: lockedStartup?.defaultModelCatalog,
        });

        if (invalidate === "generation") {
          const retained = await prepareModelsListResult({
            source: {
              kind: "gateway",
              context: nativeContext,
            },
            agentId: "main",
            params: { view: "configured", preparedOnly: true },
          });
          expect(retained.isCurrent()).toBe(true);
          expect(retained.read()).toMatchObject({ models: expectedModels(true) });
          const entered = createDeferredCore();
          const release = createDeferredCore<{ agentDir: string; wrote: false }>();
          mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
            entered.resolve();
            return await release.promise;
          });
          const events: string[] = [];
          const published = createDeferredCore();
          const unregister = registerPreparedModelRuntimePublicationListener((event) => {
            events.push(event.phase);
            if (event.phase === "published" || event.phase === "failed") {
              published.resolve();
            }
          });
          let nextRead: ReturnType<typeof lifecycle.read> | undefined;
          try {
            expect(mocks.mutationListener).toBeTypeOf("function");
            mocks.mutationListener!({
              agentDir: state.agentDir("main"),
              affectsInheritedStores: false,
            });
            expect(events).toEqual(["invalidated"]);
            let settled = false;
            nextRead = lifecycle.read({ agentId: "main" });
            void nextRead.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            await entered.promise;
            expect(settled).toBe(false);
            await expect(
              lifecycle.readStartup({ agentId: "main", readPolicy: "ready" }),
            ).resolves.toBeUndefined();
            const staleCurrent = retained.isCurrent();
            const staleModels = retained.read().models;
            release.resolve({ agentDir: state.agentDir("main"), wrote: false });
            await published.promise;
            expect(events).toContain("published");
            expect(events).not.toContain("failed");
            await expect(nextRead).resolves.toMatchObject({ models: expectedModels(true) });
            const replacement = readOwner();
            expect(replacement).toBeDefined();
            expect(replacement).not.toBe(owner);
            expect(replacement?.pluginRegistry).toBe(owner.pluginRegistry);
            expect(loadModelCatalog).toHaveBeenCalledTimes(1 + preparationCalls);
            await lifecycle.read({ agentId: "main" });
            expect(loadModelCatalog).toHaveBeenCalledTimes(1 + preparationCalls);
            expect({ current: staleCurrent, models: staleModels }).toMatchObject({
              current: false,
              models: expectedModels(false),
            });
          } finally {
            release.resolve({ agentDir: state.agentDir("main"), wrote: false });
            await Promise.allSettled([nextRead]);
            unregister();
          }
          return;
        }

        currentConfig = { ...nativeConfig };
        await lifecycle.refresh();
        // Equivalent lifecycle facts can retain a generation, but its prepared wrappers
        // still belong to the previous config object until a canonical read refreshes them.
        await expect(
          lifecycle.readStartup({ agentId: "main", readPolicy: "ready" }),
        ).resolves.toBeUndefined();
        await lifecycle.read({ agentId: "main" });
        await expectNativeAvailable(true);

        if (invalidate === "stamp") {
          advancePreparedModelRuntimeConfig(currentConfig);
          const advanced = readOwner();
          expect(advanced).not.toBe(owner);
          expect(advanced?.config).toBe(currentConfig);
          expect(advanced?.pluginRegistry).toBe(owner.pluginRegistry);
          await lifecycle.refresh();
          expect(loadModelCatalog).toHaveBeenCalledTimes(1);
          expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(builds);
          await expectNativeAvailable(true);
          return;
        }

        revision += 1;
        await expectNativeAvailable(false);
        await loadModelCatalog();
        await expectNativeAvailable(true);
        // Revocation during an asynchronous read must win before the response is returned.
        const racingRead = lifecycle.read({ agentId: "main" });
        if (invalidate === "dispose") {
          disposed = true;
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
        await expect(racingRead).resolves.toMatchObject({
          models: expectedModels(invalidate === "registry"),
        });
        await expectNativeAvailable(invalidate === "registry");
        expect(loadModelCatalog).toHaveBeenCalledTimes(2);
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(builds);
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  it.each([
    ["SecretRef-only runtime auth", "secret-ref", true, false],
    ["SecretRef auth after profile-scoped catalog rejection", "secret-ref", true, true],
    ["external CLI OAuth bootstrap", "external-oauth", true, false],
    ["unresolved SecretRef", "unresolved-secret-ref", false, false],
  ] as const)(
    "converges chat metadata and models.list for %s",
    async (_, kind, available, rejected) => {
      configureAuthFixture(kind, rejected);
      await publishOwner();
      const lifecycle = await createLifecycle();
      await lifecycle.attachContext(context, sidecars.publish);

      await expectAvailable(lifecycle, available);
    },
  );

  it.each([true, false])(
    "keeps metadata reads bounded when a plugin retires (before replacement: %s)",
    async (retireBeforeReplacement) => {
      const projectionModule = await import("./server-methods/chat-metadata-session-projection.js");
      const prepare = projectionModule.prepareChatMetadataModelProjection;
      let projections = 0;
      // Bound the original microtask loop without replacing the real projection or its currency.
      const projection = vi
        .spyOn(projectionModule, "prepareChatMetadataModelProjection")
        .mockImplementation(async (params) => {
          if (++projections > 10) {
            throw new Error("Metadata repeatedly projected a retired owner");
          }
          return prepare(params);
        });
      const rosterConfig: OpenClawConfig = {
        ...config,
        agents: { ...config.agents, list: [{ id: "main", default: true }, { id: "healthy" }] },
      };
      mocks.configuredAgentIds = ["main", "healthy"];
      const retiredRegistry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "metadata-retirement" });
      retiredRegistry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry: retiredRegistry });
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(
        (params: { workspaceDir?: string }) =>
          params.workspaceDir === "/tmp/workspace-main"
            ? retiredRegistry
            : createEmptyPluginRegistry(),
      );
      const lifecycle = await createLifecycle(() => rosterConfig);
      try {
        await publishOwner(rosterConfig);
        await lifecycle.attachContext(
          { ...context, getRuntimeConfig: () => rosterConfig },
          sidecars.publish,
        );
        const healthy = await lifecycle.read({ agentId: "healthy" });
        await expect(lifecycle.read({ agentId: "main" })).resolves.toHaveProperty("models");
        if (retireBeforeReplacement) {
          quiescePluginRegistry(retiredRegistry);
          expect(instance.acceptingCalls).toBe(false);
          await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow(
            'prepared chat metadata owner retired for agent "main"',
          );
          await expect(lifecycle.read({ agentId: "healthy" })).resolves.toEqual(healthy);
        }
        mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(createEmptyPluginRegistry);
        const replacement = publishOwner(rosterConfig);
        const reading = lifecycle.read({ agentId: "main" });
        await replacement;
        const expected = await reading;
        quiescePluginRegistry(retiredRegistry);
        expect(instance.acceptingCalls).toBe(false);
        await expect(lifecycle.read({ agentId: "main" })).resolves.toEqual(expected);
        await expect(lifecycle.read({ agentId: "healthy" })).resolves.toEqual(healthy);
      } finally {
        projection.mockRestore();
      }
    },
  );

  it("keeps the published owner across a display-only config publication", async () => {
    const publishedConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: true } },
    } satisfies OpenClawConfig;
    const currentConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: false } },
    } satisfies OpenClawConfig;
    await publishOwner(publishedConfig);
    const lifecycle = await createLifecycle(() => currentConfig);
    const currentContext = createCatalogContext(() => currentConfig);

    await lifecycle.attachContext(currentContext, sidecars.publish);

    await expect(lifecycle.read({ agentId: "main" })).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          available: true,
          id: "gpt-5.4",
          provider: "openai",
        }),
      ],
    });
  });

  it("publishes a successful harness auth binding before the next metadata read", async () => {
    configureHarnessOwnedUnresolvedAuth();
    await publishOwner();
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars.publish);
    await expectAvailable(lifecycle, false);
    const profileStore = mocks.preparedAuthStore;
    if (!profileStore) {
      throw new Error("expected unresolved prepared auth store");
    }

    reportEmbeddedRunSuccessfulAuthBinding({
      profileStore,
      apiKeyInfo: null,
      attempt: {
        runtimeArtifact: {
          id: "codex-app-server:test",
          fingerprint: "codex-runtime-fingerprint",
        },
      } as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: state.agentDir("main"),
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      requestTransportOverrides: "none",
      config,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    expect(mocks.preparedAuthMaterializations).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      }),
    ]);

    await vi.waitFor(async () => await expectAvailable(lifecycle));

    revokeRuntimeAuthMaterializations({
      agentDir: state.agentDir("main"),
      provider: "openai",
      runtimeOwnerId: "codex",
    });
    await vi.waitFor(async () => await expectAvailable(lifecycle, false));
  });

  it("publishes a successful prepared API-key route before the next metadata read", async () => {
    const orderedConfig = {
      ...config,
      auth: { order: { openai: ["openai:default"] } },
    } satisfies OpenClawConfig;
    const orderedContext = {
      ...context,
      getRuntimeConfig: () => orderedConfig,
    } as GatewayRequestContext;
    configureAuthFixture("unresolved-secret-ref");
    await publishOwner(orderedConfig);
    const lifecycle = await createLifecycle(() => orderedConfig);
    await lifecycle.attachContext(orderedContext, sidecars.publish);
    await expectAvailable(lifecycle, false, orderedConfig, orderedContext);
    const profileStore = mocks.preparedAuthStore;
    if (!profileStore) {
      throw new Error("expected unresolved prepared auth store");
    }

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:default",
      profileStore,
      apiKeyInfo: {
        apiKey: "resolved-at-runtime",
        source: "profile:openai:default",
        mode: "api-key",
        profileId: "openai:default",
      },
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: state.agentDir("main"),
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none",
      config: orderedConfig,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(mocks.preparedAuthMaterializations).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none",
        authMode: "api-key",
        runtimeOwnerId: "codex",
        authProfileId: "openai:default",
      }),
    ]);

    await vi.waitFor(
      async () => await expectAvailable(lifecycle, true, orderedConfig, orderedContext),
    );

    revokeRuntimeAuthMaterializations({
      agentDir: state.agentDir("main"),
      provider: "openai",
      runtimeOwnerId: "codex",
    });
    await vi.waitFor(
      async () => await expectAvailable(lifecycle, false, orderedConfig, orderedContext),
    );
  });

  it("retains a settled metadata failure during a later independent auth publication", async () => {
    mocks.configuredAgentIds = ["main", "worker"];
    await publishOwner();
    const lifecycle = await createLifecycle();
    const ownedSidecars = createGatewaySidecarStopOwner();
    const failure = new Error("worker auth publication failed");
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      phases.push(event.phase);
    });
    let failedDispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let healthyDispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let metadataRead: Promise<void> | undefined;
    try {
      await lifecycle.attachContext(context, ownedSidecars.publish);
      await expectAvailable(lifecycle);
      mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(failure);
      expect(mocks.mutationListener).toBeTypeOf("function");
      mocks.mutationListener!({
        agentDir: state.agentDir("worker"),
        affectsInheritedStores: false,
      });
      failedDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      await expect(failedDispatch).rejects.toBe(failure);
      await expect(lifecycle.read({ agentId: "main" })).rejects.toBe(failure);
      // Drain the completed publication's promise continuations before starting a new
      // transaction; this must not exercise two components of one queued transaction.
      await nextEventLoopTurn();
      expect(phases).toEqual(["invalidated", "failed"]);
      phases.length = 0;

      mocks.mutationListener!({
        agentDir: state.agentDir("main"),
        affectsInheritedStores: false,
      });
      healthyDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
      let metadataOutcome: unknown = Symbol("pending");
      metadataRead = lifecycle.read({ agentId: "main" }).then(
        (value) => {
          metadataOutcome = value;
        },
        (error: unknown) => {
          metadataOutcome = error;
        },
      );
      await expect(healthyDispatch).resolves.toMatchObject({ agentId: "main" });
      await nextEventLoopTurn();
      expect(phases).toContain("invalidated");
      expect(phases).not.toContain("published");
      expect(getPreparedModelCatalogOwnerSnapshot({ agentId: "worker", config })).toBeUndefined();
      // The healthy component can admit work, but it cannot make the failed global
      // metadata generation ready or turn its recorded failure into an endless wait.
      expect(metadataOutcome).toBe(failure);

      await publishOwner();
      await expectAvailable(lifecycle);
    } finally {
      unregister();
      await ownedSidecars.stop();
      await Promise.allSettled([failedDispatch, healthyDispatch, metadataRead]);
    }
  });

  it("recovers a failed catch-up when the prepared owner publishes after attachment", async () => {
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars.publish);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );

    await publishOwner();

    await vi.waitFor(async () => await expectAvailable(lifecycle));
  });
});
