// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeRuntimeAuthMaterializations } from "../agents/auth-profiles/runtime-materializations.js";
import { reportEmbeddedRunSuccessfulAuthBinding } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import type { EmbeddedRunAttemptResult } from "../agents/embedded-agent-runner/run/types.js";
import type { AgentHarnessV2 } from "../agents/harness/types.js";
import { createModelCatalogDecisions } from "../agents/model-catalog-decisions.js";
import { getPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
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
const main = { agentId: "main" };
const configured = { view: "configured" as const, preparedOnly: true };
const nativeRow = (id: string, name = id) => ({
  provider: "openai",
  id,
  name,
  nativeRuntime: "native-test",
});
function nativeConfig(refs: string[], primary?: string): OpenClawConfig {
  return {
    agents: {
      entries: { main: {} },
      defaults: {
        ...(primary ? { model: primary } : {}),
        models: Object.fromEntries(
          refs.map((ref) => [ref, { agentRuntime: { id: "native-test" } }]),
        ),
        modelPolicy: { allow: refs },
      },
    },
  };
}
let state: OpenClawTestState;
const config = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": {} },
      modelPolicy: { allow: ["openai/gpt-5.4"] },
    },
    entries: { main: {} },
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
  const lifecycle = await createGatewayChatMetadataLifecycle({
    getConfig,
    log: { warn: vi.fn() } as never,
  });
  return {
    ...lifecycle,
    readMain: (params: Omit<Parameters<typeof lifecycle.read>[0], "agentId"> = {}) =>
      lifecycle.read({ ...main, ...params }),
    startup: (params: Omit<Parameters<typeof lifecycle.readStartup>[0], "agentId"> = {}) =>
      lifecycle.readStartup({ ...main, ...params }),
  };
}

async function attachLifecycle(activeContext = context, activeSidecars = sidecars) {
  const lifecycle = await createLifecycle(activeContext.getRuntimeConfig);
  await lifecycle.attachContext(activeContext, activeSidecars.publish);
  return lifecycle;
}

function readOwner(activeConfig = config) {
  return getPreparedModelCatalogOwnerSnapshot({
    agentId: "main",
    config: activeConfig,
    readOnly: true,
    allowGatewaySubagentBinding: true,
  });
}

function installNativeHarness(
  methods: Pick<AgentHarnessV2, "loadModelCatalog" | "readModelCatalogReadiness">,
) {
  const harness: AgentHarnessV2 = {
    id: "native-test",
    label: "Synthetic native harness",
    authBootstrap: "harness",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
    ...methods,
  };
  const previousRegistry = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({ pluginId: harness.id, source: "test", harness });
  setActivePluginRegistry(registry);
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  mocks.authStorage.getAll.mockReturnValue({});
  const authStore = { version: 1, profiles: {} };
  mocks.preparedAuthStore = authStore;
  return { previousRegistry, authStore };
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
  const owner = readOwner(activeConfig);
  assert(owner, "expected prepared model owner");
  const projector = createModelCatalogDecisions({
    cfg: activeConfig,
    agentId: "main",
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: mocks.preparedAuthStore ?? { version: 1, profiles: {} },
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
  });
  const [metadata, modelsList] = await Promise.all([
    lifecycle.read(main),
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
  for (const { models } of [metadata, modelsList]) {
    expect(
      models?.find(({ id, provider }) => id === "gpt-5.4" && provider === "openai")?.available,
    ).toBe(expectedAvailable);
  }
}

describe("gateway chat metadata lifecycle composition", () => {
  it("joins superseding owner replacements when an explicit catch-up overlaps publication", async () => {
    await publishOwner();
    const lifecycle = await attachLifecycle();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const successorEntered = createDeferredCore();
    const successorRelease = createDeferredCore();
    mocks.buildPreparedModelCatalogSnapshot
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { entries: [model], routeVariants: [model] };
      })
      .mockImplementationOnce(async () => {
        successorEntered.resolve();
        await successorRelease.promise;
        return { entries: [model], routeVariants: [model] };
      });
    const publication = publishOwner().catch((error: unknown) => error);
    await entered.promise;
    let refreshed = false;
    const refresh = lifecycle.refresh().then(() => {
      refreshed = true;
    });
    const reads = Promise.all([
      lifecycle.readMain(),
      lifecycle.readModelsList({
        agentId: "main",
        params: { view: "configured", preparedOnly: true },
        includeManualSelection: false,
      }),
    ]);
    let successor: Promise<void> | undefined;
    try {
      await nextEventLoopTurn();
      expect(refreshed).toBe(false);
      successor = publishOwner();
      release.resolve();
      await successorEntered.promise;
      await nextEventLoopTurn();
      expect(refreshed).toBe(false);
      successorRelease.resolve();
      expect(await publication).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      await successor;
      await refresh;
      const results = await reads;
      for (const result of results) {
        expect(result?.models).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4", provider: "openai" })]),
        );
      }
    } finally {
      release.resolve();
      successorRelease.resolve();
      await Promise.allSettled([publication, successor, refresh, reads]);
    }
  });

  it.each([false, true])(
    "publishes coherent native membership when readiness changes from %s during preparation",
    async (initialReady) => {
      const nativeCfg = nativeConfig(["openai/*", "openai/gpt-5.6-luna"], "openai/gpt-5.6-luna");
      const rows = ["codex-latest", "gpt-5.6-luna"].map((id) => nativeRow(id));
      let ready = initialReady;
      const loadModelCatalog = vi.fn(async () => rows);
      const { previousRegistry, authStore } = installNativeHarness({
        loadModelCatalog,
        readModelCatalogReadiness: () => (ready ? { accountType: "apiKey" } : undefined),
      });
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: rows,
        routeVariants: rows,
      });
      let result: ReturnType<typeof buildModelsListResult> | undefined;
      try {
        await publishOwner(nativeCfg);
        expect(loadModelCatalog).toHaveBeenCalled();
        loadModelCatalog.mockClear();
        const owner = readOwner(nativeCfg);
        assert(owner, "expected prepared native model owner");
        const projector = createModelCatalogDecisions({
          cfg: owner.config,
          agentId: "main",
          snapshot: owner.modelCatalog,
          metadataSnapshot: owner.metadataSnapshot,
          preparedAuthStore: authStore,
          preparedRuntimeAuthModes: owner.authModes,
        });
        const evaluateEntry = projector.evaluateEntry;
        const evaluations = vi
          .spyOn(projector, "evaluateEntry")
          .mockImplementation((entry, variants) => {
            if (entry.id === "gpt-5.6-luna") {
              ready = !initialReady;
            }
            return evaluateEntry(entry, variants);
          });
        const builds = mocks.buildPreparedModelCatalogSnapshot.mock.calls.length;
        const request = {
          source: {
            kind: "gateway" as const,
            context: { ...context, getRuntimeConfig: () => nativeCfg },
          },
          agentId: "main",
          params: configured,
          preloadedOnly: true,
          preloadedCatalog: { ...main, config: owner.config, snapshot: owner.modelCatalog },
          catalogProjector: projector,
        };
        result = buildModelsListResult(request);
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
          expect(membership.toSorted(([a], [b]) => String(a).localeCompare(String(b)))).toEqual(
            ready
              ? [
                  ["codex-latest", true],
                  ["gpt-5.6-luna", true],
                ]
              : [["gpt-5.6-luna", false]],
          );
        }
        expect(evaluations).toHaveBeenCalledTimes(hostCalls);
        expect(loadModelCatalog).not.toHaveBeenCalled();
      } finally {
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
      const nativeCfg = nativeConfig([modelRef]); // Discovery also works without a primary model.
      let currentConfig = nativeCfg;
      const currentOwner = () => readOwner(currentConfig);
      const nativeModel = { ...nativeRow("codex-latest", "Codex (Latest)"), reasoning: true };
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
          config: nativeCfg,
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          modelId: "codex-latest",
        });
        // Native observations retain their preparation identity across public config stamps.
        if (scope.config !== currentOwner()?.observationConfig) {
          return undefined;
        }
        return !disposed && observedRevision === revision ? { accountType: "apiKey" } : undefined;
      });
      const { previousRegistry } = installNativeHarness({
        loadModelCatalog,
        readModelCatalogReadiness,
      });
      const catalog = { entries: [nativeModel], routeVariants: [nativeModel], authoritative };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue(catalog);
      // Startup discovery builds the same catalog in the worker.
      mocks.runPreparedModelCatalogWorker.mockImplementation(async () => structuredClone(catalog));
      const nativeContext = createCatalogContext(() => currentConfig);
      const loader = nativeContext.loadGatewayModelCatalogSnapshot;
      try {
        await publishOwner(nativeCfg);
        // This fixture tests retained discovery; startup now acquires provider inventory only.
        await currentOwner()?.loadNativeModelCatalog?.();
        expect(loadModelCatalog).toHaveBeenCalled();
        loadModelCatalog.mockClear();
        revision += 1;
        const lifecycle = await attachLifecycle(nativeContext);
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
        const owner = currentOwner();
        assert(owner, "expected prepared native model owner");
        const expectNativeAvailable = async (available: boolean) => {
          const expected = { models: expectedModels(available) };
          const params = { ...main, ...configured };
          const respond = vi.fn();
          const handler = modelsHandlers["models.list"];
          assert(handler, "models.list handler missing");
          await handler({
            req: { type: "req", id: "native-noop-models", method: "models.list", params },
            params,
            respond,
            client: null,
            isWebchatConnect: () => false,
            context: nativeContext,
          });
          expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(expected), undefined);
          await expect(lifecycle.readMain()).resolves.toMatchObject(expected);
          const catalogs = await lifecycle.startup({ readPolicy: "ready" });
          expect(catalogs?.sessionModelCatalog).toBe(catalogs?.defaultModelCatalog);
          expect(catalogs).not.toHaveProperty("metadata");
          await expect(lifecycle.startup()).resolves.toMatchObject({
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
          expect([sessionEntry.modelOverride, sessionEntry.modelOverrideSource]).toEqual(
            authoritative === false
              ? ["account-model-unavailable", "user"]
              : [undefined, undefined],
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
          lifecycle.startup({ sessionEntry: lockedSession, readPolicy: "ready" }),
        ).resolves.toBeUndefined();
        const lockedMetadata = await lifecycle.readMain({ sessionEntry: lockedSession });
        expect(lockedMetadata).toMatchObject({
          models: wildcard
            ? []
            : [expect.objectContaining({ id: "codex-latest", available: false })],
        });
        const lockedStartup = await lifecycle.startup({ sessionEntry: lockedSession });
        expect(lockedStartup?.metadata).toEqual(lockedMetadata);
        await expect(
          lifecycle.startup({ sessionEntry: lockedSession, readPolicy: "ready" }),
        ).resolves.toEqual({
          sessionModelCatalog: lockedStartup?.sessionModelCatalog,
          defaultModelCatalog: lockedStartup?.defaultModelCatalog,
        });

        if (invalidate === "generation") {
          const retained = await prepareModelsListResult({
            source: { kind: "gateway", context: nativeContext },
            agentId: "main",
            params: configured,
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
            nextRead = lifecycle.readMain();
            const markSettled = () => {
              settled = true;
            };
            void nextRead.then(markSettled, markSettled);
            await entered.promise;
            expect(settled).toBe(false);
            await expect(lifecycle.startup({ readPolicy: "ready" })).resolves.toBeUndefined();
            const staleCurrent = retained.isCurrent();
            const staleModels = retained.read().models;
            release.resolve({ agentDir: state.agentDir("main"), wrote: false });
            await published.promise;
            expect(events).toContain("published");
            expect(events).not.toContain("failed");
            await expect(nextRead).resolves.toMatchObject({
              models: [
                expect.objectContaining({
                  id: "codex-latest",
                  name: "codex-latest",
                  available: true,
                }),
              ],
            });
            const replacement = currentOwner();
            expect(replacement).toBeDefined();
            expect(replacement).not.toBe(owner);
            expect(replacement?.pluginRegistry).toBe(owner.pluginRegistry);
            await replacement?.loadNativeModelCatalog?.();
            const nativeCalls = loadModelCatalog.mock.calls.length;
            await expect(lifecycle.readMain()).resolves.toMatchObject({
              models: expectedModels(true),
            });
            await lifecycle.readMain();
            expect(loadModelCatalog).toHaveBeenCalledTimes(nativeCalls);
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

        const retainedStartup = await lifecycle.startup({ readPolicy: "ready" });
        expect(retainedStartup).toBeDefined();
        currentConfig = { ...nativeCfg };
        await lifecycle.refresh();
        const copiedStartup = await lifecycle.startup({ readPolicy: "ready" });
        expect(copiedStartup?.sessionModelCatalog).toBe(retainedStartup?.sessionModelCatalog);
        expect(copiedStartup?.defaultModelCatalog).toBe(retainedStartup?.defaultModelCatalog);
        await lifecycle.readMain();
        await expectNativeAvailable(true);

        if (invalidate === "stamp") {
          advancePreparedModelRuntimeConfig(currentConfig);
          const advanced = currentOwner();
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
        const racingRead = lifecycle.readMain();
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
  ] as const)(
    "converges chat metadata and models.list for %s",
    async (_, kind, available, rejected) => {
      configureAuthFixture(kind, rejected);
      await publishOwner();
      const lifecycle = await attachLifecycle();

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
        agents: { ...config.agents, entries: { main: {}, healthy: {} } },
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
        await expect(lifecycle.readMain()).resolves.toHaveProperty("models");
        if (retireBeforeReplacement) {
          quiescePluginRegistry(retiredRegistry);
          expect(instance.acceptingCalls).toBe(false);
          await expect(lifecycle.readMain()).rejects.toThrow(
            'prepared chat metadata owner retired for agent "main"',
          );
          await expect(lifecycle.read({ agentId: "healthy" })).resolves.toEqual(healthy);
        }
        mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(createEmptyPluginRegistry);
        const replacement = publishOwner(rosterConfig);
        const reading = lifecycle.readMain();
        await replacement;
        const expected = await reading;
        quiescePluginRegistry(retiredRegistry);
        expect(instance.acceptingCalls).toBe(false);
        await expect(lifecycle.readMain()).resolves.toEqual(expected);
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
    const currentContext = createCatalogContext(() => currentConfig);
    const lifecycle = await attachLifecycle(currentContext);

    await expect(lifecycle.readMain()).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          available: true,
          id: "gpt-5.4",
          provider: "openai",
        }),
      ],
    });
  });

  it.each(["harness", "api-key"] as const)(
    "publishes a successful %s auth binding before the next metadata read",
    async (kind) => {
      const apiKey = kind === "api-key";
      const activeConfig = apiKey
        ? { ...config, auth: { order: { openai: ["openai:default"] } } }
        : config;
      const activeContext = { ...context, getRuntimeConfig: () => activeConfig };
      if (apiKey) {
        configureAuthFixture("unresolved-secret-ref");
      } else {
        configureHarnessOwnedUnresolvedAuth();
      }
      await publishOwner(activeConfig);
      const lifecycle = await attachLifecycle(activeContext);
      const expectAvailability = (available = true) =>
        expectAvailable(lifecycle, available, activeConfig, activeContext);
      await expectAvailability(false);
      const modelApi = apiKey ? "openai-responses" : "openai-chatgpt-responses";
      const modelBaseUrl = apiKey
        ? "https://api.openai.com/v1"
        : "https://chatgpt.com/backend-api/codex";
      const profileStore = mocks.preparedAuthStore;
      assert(profileStore, "expected unresolved prepared auth store");
      reportEmbeddedRunSuccessfulAuthBinding({
        profileStore,
        provider: "openai",
        agentDir: state.agentDir("main"),
        modelId: "gpt-5.4",
        requestTransportOverrides: "none",
        agentHarnessId: "codex",
        pluginHarnessOwnsTransport: true,
        pluginHarnessOwnsAuthBootstrap: true,
        ...(apiKey ? { profileId: "openai:default" } : {}),
        apiKeyInfo: apiKey
          ? {
              apiKey: "resolved-at-runtime",
              source: "profile:openai:default",
              mode: "api-key",
              profileId: "openai:default",
            }
          : null,
        attempt: (apiKey
          ? {}
          : {
              runtimeArtifact: {
                id: "codex-app-server:test",
                fingerprint: "codex-runtime-fingerprint",
              },
            }) as EmbeddedRunAttemptResult,
        modelApi,
        modelBaseUrl,
        config: activeConfig,
      });
      if (!apiKey) {
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      }
      expect(mocks.preparedAuthMaterializations).toEqual([
        expect.objectContaining({
          provider: "openai",
          modelId: "gpt-5.4",
          modelApi,
          modelBaseUrl,
          requestTransportOverrides: "none",
          authMode: apiKey ? "api-key" : "oauth",
          runtimeOwnerId: "codex",
          ...(apiKey ? { authProfileId: "openai:default" } : {}),
        }),
      ]);
      await vi.waitFor(() => expectAvailability());
      revokeRuntimeAuthMaterializations({
        agentDir: state.agentDir("main"),
        provider: "openai",
        runtimeOwnerId: "codex",
      });
      await vi.waitFor(() => expectAvailability(false));
    },
  );

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
      await expect(lifecycle.readMain()).rejects.toBe(failure);
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
      metadataRead = lifecycle
        .readMain()
        .catch((error: unknown) => error)
        .then((value) => {
          metadataOutcome = value;
        });
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

  it("adopts a prepared owner that publishes after attachment", async () => {
    const lifecycle = await attachLifecycle();
    await expect(lifecycle.readMain()).rejects.toThrow(
      'prepared chat metadata is unavailable for agent "main"',
    );

    await publishOwner();

    await vi.waitFor(async () => await expectAvailable(lifecycle));
  });
});
