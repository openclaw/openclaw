import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { getRuntimeConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createPluginBlobStore,
  type OpenBlobStoreOptions,
} from "../plugin-state/plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenAsyncKeyedStoreOptions,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { PluginTrustRefusalError } from "./plugin-trust.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  getPluginRegistryResourceOwner,
  isPluginRecordActive,
  isPluginRegistryPreparing,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  ExpiredPluginRegistryScopeError,
  bindGatewayContextResolver,
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

// A completed reaction must retain only the emptied holder, not the caller's registry closure.
function createRuntimeRegistryRelease(held: PluginRegistry[]) {
  return () => {
    held.length = 0;
  };
}

/** One namespace projection belongs to its runtime source, not the invocation reading it. */
function createRuntimeFacade<T>() {
  let cached: { source: T; value: T } | undefined;
  return (source: T, project: (source: T) => T): T => {
    if (cached && cached.source === source) {
      return cached.value;
    }
    const value = project(source);
    cached = { source, value };
    return value;
  };
}

export function createPluginRuntimeResolver(state: PluginRegistryState) {
  const { registry, registryParams } = state;
  const pluginRuntimes = new WeakMap<PluginRecord, PluginRuntime>();
  const registeredChannelRuntime = new WeakMap<PluginRecord, PluginRuntime["channel"]>();
  const registeredRuntimeRecordById = new Map<string, PluginRecord>();
  const registeredAdmissionOwnerByRecord = new WeakMap<
    PluginRecord,
    { isLive: () => boolean; dispose: () => void }
  >();

  const addPluginRuntimeResolutionContext = (params: {
    error: unknown;
    record: PluginRecord;
    prop: PropertyKey;
  }): never => {
    const { error, record, prop } = params;
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve plugin runtime module") &&
      !error.message.includes("pluginRuntimeContext=")
    ) {
      const propName =
        typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
      error.message = [
        error.message,
        `pluginRuntimeContext=pluginId:${record.id}`,
        `property:${propName}`,
        ...(record.source ? [`source:${record.source}`] : []),
      ].join("; ");
    }
    throw error;
  };

  const resolveRecordChannelRuntime = (record: PluginRecord): PluginRuntime["channel"] => {
    const cached = registeredChannelRuntime.get(record);
    const cachedOwner = registeredAdmissionOwnerByRecord.get(record);
    if (cached && cachedOwner?.isLive() === true) {
      return cached;
    }
    if (cachedOwner) {
      cachedOwner.dispose();
      registeredAdmissionOwnerByRecord.delete(record);
    }
    const channel = (() => {
      try {
        return Reflect.get(
          registryParams.runtime,
          "channel",
          registryParams.runtime,
        ) as PluginRuntime["channel"];
      } catch (error) {
        return addPluginRuntimeResolutionContext({
          error,
          record,
          prop: "channel",
        });
      }
    })();
    if (
      (record.origin !== "bundled" && record.trustedOfficialInstall !== true) ||
      !registry.channels.some((entry) => entry.pluginId === record.id) ||
      !isPluginRecordActive(registry, record)
    ) {
      return channel;
    }
    let closed = false;
    const ownsLiveRegistrySlot = () =>
      !closed &&
      registeredRuntimeRecordById.get(record.id) === record &&
      isPluginRecordActive(registry, record);
    const previousRecord = registeredRuntimeRecordById.get(record.id);
    if (previousRecord && previousRecord !== record) {
      registeredAdmissionOwnerByRecord.get(previousRecord)?.dispose();
      registeredAdmissionOwnerByRecord.delete(previousRecord);
      revokePluginRecord(registry, previousRecord);
    }
    registeredRuntimeRecordById.set(record.id, record);
    const resolveGatewayContext = getGatewayContextResolver(registryParams.runtime.subagent);
    const scopedGatewayContext = resolveGatewayContext
      ? () => (ownsLiveRegistrySlot() ? resolveGatewayContext() : undefined)
      : undefined;
    if (scopedGatewayContext && resolveGatewayContext) {
      bindGatewayContextResolver(
        scopedGatewayContext,
        getCanonicalGatewayContextResolver(resolveGatewayContext),
      );
    }
    const owner = Object.freeze({
      channelId: record.id,
      resolveGatewayContext: scopedGatewayContext,
      isLive: ownsLiveRegistrySlot,
    });
    registeredAdmissionOwnerByRecord.set(record, {
      isLive: owner.isLive,
      dispose: () => {
        closed = true;
      },
    });
    const buildHostContext = createHostChannelInboundEventContextBuilder(
      channel.inbound.buildContext,
      owner,
    );
    const buildContext = ((
      params: Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0],
    ) => {
      // Audit provenance is passive: stale closures still build the message context,
      // but only the exact live trusted owner may attach participant evidence.
      return buildHostContext(params as never);
    }) as unknown as PluginRuntime["channel"]["inbound"]["buildContext"];
    const inbound = {
      ...channel.inbound,
      ingress: createHostChannelIngressRuntime(owner),
      buildContext,
    };
    const scoped = {
      ...channel,
      inbound,
      turn: inbound,
    } satisfies PluginRuntime["channel"];
    registeredChannelRuntime.set(record, scoped);
    return scoped;
  };

  const resolvePluginRuntime = (record: PluginRecord): PluginRuntime => {
    const pluginId = record.id;
    const cached = pluginRuntimes.get(record);
    if (cached) {
      return cached;
    }
    const currentRegistry = () => getPluginRecordRegistry(registry, record);
    const currentInvocationRegistry = (selectedRegistry?: PluginRegistry) => {
      let invocationView = selectedRegistry;
      if (invocationView === undefined) {
        try {
          invocationView = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
        } catch (error) {
          if (!(error instanceof ExpiredPluginRegistryScopeError)) {
            throw error;
          }
        }
      }
      return invocationView ?? currentRegistry();
    };
    const currentDecisionRegistry = (candidate?: PluginRegistry) => {
      const owner = currentRegistry();
      const invocationView = currentInvocationRegistry(candidate);
      // An admitted prepared view may borrow a Gateway provider. Keep that exact
      // composition without accepting an unrelated ambient registry or global owner.
      return invocationView.plugins.includes(record) &&
        getPluginRegistryResourceOwner(invocationView) === owner
        ? invocationView
        : owner;
    };
    const resolveDelegatedRuntime = (ownerPluginId: string) => {
      const owner = currentRegistry().plugins.find((entry) => entry.id === ownerPluginId);
      if (!owner) {
        throw new Error(`Plugin "${ownerPluginId}" runtime is no longer active.`);
      }
      return resolvePluginRuntime(owner);
    };
    const assertRuntimeCurrent = () => {
      if (
        !capturePluginLifecycleAuthority(currentRegistry(), record, {
          scopedRuntime: registryParams.activateGlobalSideEffects === false,
          registration: true,
          admittedRuntime: true,
        })?.()
      ) {
        throw new Error(`Plugin "${pluginId}" runtime is no longer active.`);
      }
    };
    // Cache checks, not config or row facts; actions resolve ownership after the import settles.
    const loadSessionOwnership = createLazyRuntimeSurface(
      () => import("./registry-runtime-session-ownership.js"),
      (module) => module.createPluginSessionOwnership(state, pluginId, currentRegistry),
    );
    const runWithPluginScope = <T>(
      run: () => T,
      requireActive = true,
      selectedRegistry?: PluginRegistry,
    ): T => {
      if (requireActive) {
        assertRuntimeCurrent();
      }
      const scopedRegistry = selectedRegistry ?? currentRegistry();
      return withPluginRuntimePluginScope(
        {
          pluginId,
          pluginSource: record.source,
          pluginOrigin: record.origin,
          pluginTrustedOfficialInstall: record.trustedOfficialInstall,
        },
        () => {
          const result = run();
          if (!isPromiseLike(result)) {
            return result;
          }
          // Lazy runtime imports can suspend before the operation acquires its own custody.
          return Promise.resolve(result).finally(
            createRuntimeRegistryRelease([scopedRegistry]),
          ) as T; // SAFETY: Preserve the host operation's resolved value and rejection reason.
        },
        scopedRegistry,
      );
    };
    const invokeSelectedRuntime = <T>(run: () => T): T => {
      assertRuntimeCurrent();
      return runWithPluginScope(run, false, currentInvocationRegistry());
    };
    const facades = {
      media: createRuntimeFacade<PluginRuntime["media"]>(),
      imageGeneration: createRuntimeFacade<PluginRuntime["imageGeneration"]>(),
      videoGeneration: createRuntimeFacade<PluginRuntime["videoGeneration"]>(),
      musicGeneration: createRuntimeFacade<PluginRuntime["musicGeneration"]>(),
      webSearch: createRuntimeFacade<PluginRuntime["webSearch"]>(),
      tts: createRuntimeFacade<PluginRuntime["tts"]>(),
      mediaUnderstanding: createRuntimeFacade<PluginRuntime["mediaUnderstanding"]>(),
      modelAuth: createRuntimeFacade<PluginRuntime["modelAuth"]>(),
      modelConfig: createRuntimeFacade<PluginRuntime["modelConfig"]>(),
      sandbox: createRuntimeFacade<PluginRuntime["sandbox"]>(),
    };
    let scopedAgentRuntime:
      | { source: PluginRuntime["agent"]; value: PluginRuntime["agent"] }
      | undefined;
    let scopedChannelRuntime:
      | { source: PluginRuntime["channel"]; value: PluginRuntime["channel"] }
      | undefined;
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        const getRuntimeProperty = () => {
          try {
            return Reflect.get(target, prop, receiver);
          } catch (error) {
            return addPluginRuntimeResolutionContext({ error, record, prop });
          }
        };
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          return {
            ...baseState,
            openBlobStore: <TMetadata>(options: OpenBlobStoreOptions) => {
              return createPluginBlobStore<TMetadata>(pluginId, options);
            },
            openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
              if (options.retention === "retained") {
                assertRuntimeCurrent();
              }
              return createPluginStateKeyedStore<T>(pluginId, options, assertRuntimeCurrent);
            },
            openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
            openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              const stateDir = options?.stateDir ?? baseState.resolveStateDir();
              return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>(
                { ...options, channelId: pluginId, stateDir },
                assertRuntimeCurrent,
              );
            },
            openChannelIngressDrain: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options: Omit<
                Parameters<
                  typeof createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>
                >[0],
                "queue"
              > & {
                queue?: ReturnType<
                  typeof createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>
                >;
                accountId?: string;
                stateDir?: string;
              },
            ) => {
              const stateDir = options.stateDir ?? baseState.resolveStateDir();
              const queue =
                options.queue ??
                createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>(
                  { channelId: pluginId, accountId: options.accountId, stateDir },
                  assertRuntimeCurrent,
                );
              const {
                queue: _queue,
                accountId: _accountId,
                stateDir: _stateDir,
                ...drainOptions
              } = options;
              return createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>({
                ...drainOptions,
                queue,
              });
            },
          } satisfies PluginRuntime["state"];
        }
        if (prop === "config") {
          const config: PluginRuntime["config"] = getRuntimeProperty();
          return {
            ...config,
            current: () => runWithPluginScope(() => config.current(), false),
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "system") {
          const system: PluginRuntime["system"] = getRuntimeProperty();
          const route = <T>(run: () => T): T => {
            assertRuntimeCurrent();
            if (isPluginRegistryPreparing(registry) && !isPluginRecordActive(registry, record)) {
              throw new Error(
                `Plugin "${pluginId}" cannot route system events during replacement preparation.`,
              );
            }
            return runWithPluginScope(run);
          };
          return {
            ...system,
            enqueueSystemEvent: (...args) => route(() => system.enqueueSystemEvent(...args)),
            requestHeartbeat: (...args) => route(() => system.requestHeartbeat(...args)),
            requestHeartbeatNow: (...args) => route(() => system.requestHeartbeatNow(...args)),
            runHeartbeatOnce: (...args) => route(() => system.runHeartbeatOnce(...args)),
            runCommandWithTimeout: (...args) =>
              runWithPluginScope(() => system.runCommandWithTimeout(...args)),
          } satisfies PluginRuntime["system"];
        }
        if (prop === "channel") {
          const channel = resolveRecordChannelRuntime(record);
          if (scopedChannelRuntime?.source === channel) {
            return scopedChannelRuntime.value;
          }
          const inbound = {
            ...channel.inbound,
            run: ((...args: Parameters<typeof channel.inbound.run>) =>
              invokeSelectedRuntime(() =>
                channel.inbound.run(...args),
              )) as typeof channel.inbound.run, // SAFETY: Forward unchanged arguments/results for both generic run overloads.
            runPreparedReply: (...args) =>
              invokeSelectedRuntime(() => channel.inbound.runPreparedReply(...args)),
            dispatch: ((...args: Parameters<typeof channel.inbound.dispatch>) =>
              invokeSelectedRuntime(() =>
                channel.inbound.dispatch(...args),
              )) as typeof channel.inbound.dispatch, // SAFETY: Preserve each routed-turn overload and its result.
            dispatchReply: (...args) =>
              invokeSelectedRuntime(() => channel.inbound.dispatchReply(...args)),
          } satisfies PluginRuntime["channel"]["inbound"];
          const value = {
            ...channel,
            inbound,
            turn: inbound,
            outbound: {
              ...channel.outbound,
              loadAdapter: (...args) =>
                invokeSelectedRuntime(() => channel.outbound.loadAdapter(...args)),
            },
            threadBindings: {
              setIdleTimeoutBySessionKey: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setIdleTimeoutBySessionKey(...args),
                ),
              setMaxAgeBySessionKey: (...args) =>
                invokeSelectedRuntime(() => channel.threadBindings.setMaxAgeBySessionKey(...args)),
              setIdleTimeoutBySessionKeyAsync: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setIdleTimeoutBySessionKeyAsync(...args),
                ),
              setMaxAgeBySessionKeyAsync: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setMaxAgeBySessionKeyAsync(...args),
                ),
            },
            reply: {
              ...channel.reply,
              dispatchReplyFromConfig: (...args) =>
                invokeSelectedRuntime(() => channel.reply.dispatchReplyFromConfig(...args)),
              dispatchReplyWithBufferedBlockDispatcher: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.reply.dispatchReplyWithBufferedBlockDispatcher(...args),
                ),
            },
          } satisfies PluginRuntime["channel"];
          scopedChannelRuntime = { source: channel, value };
          return value;
        }
        if (prop === "decisions") {
          return {
            evaluate: async (batch, options) => {
              assertRuntimeCurrent();
              const capturedRegistry = currentDecisionRegistry();
              const { evaluateDecisionInRegistry } = await import("../decisions/runtime.js");
              assertRuntimeCurrent();
              const selectedRegistry = currentDecisionRegistry(capturedRegistry);
              const result = await withPluginRuntimeRegistryScope(selectedRegistry, () =>
                evaluateDecisionInRegistry(
                  batch,
                  options,
                  selectedRegistry,
                  getRuntimeConfig(),
                  record.id,
                ),
              );
              assertRuntimeCurrent();
              options.signal.throwIfAborted();
              return result;
            },
          } satisfies PluginRuntime["decisions"];
        }
        if (prop === "llm") {
          const llm = getRuntimeProperty();
          return {
            acquireLocalService: (...args) =>
              runWithPluginScope(() => llm.acquireLocalService(...args)),
            complete: (params) => runWithPluginScope(() => llm.complete(params)),
          } satisfies PluginRuntime["llm"];
        }
        if (prop === "media") {
          return facades.media(getRuntimeProperty(), (media) => ({
            ...media,
            loadWebMedia: (...args) => invokeSelectedRuntime(() => media.loadWebMedia(...args)),
          }));
        }
        if (prop === "imageGeneration") {
          return facades.imageGeneration(getRuntimeProperty(), (image) => ({
            ...image,
            generate: (...args) => invokeSelectedRuntime(() => image.generate(...args)),
            listProviders: (...args) => invokeSelectedRuntime(() => image.listProviders(...args)),
          }));
        }
        if (prop === "videoGeneration") {
          return facades.videoGeneration(getRuntimeProperty(), (video) => ({
            ...video,
            generate: (...args) => invokeSelectedRuntime(() => video.generate(...args)),
            listProviders: (...args) => invokeSelectedRuntime(() => video.listProviders(...args)),
          }));
        }
        if (prop === "musicGeneration") {
          return facades.musicGeneration(getRuntimeProperty(), (music) => ({
            ...music,
            generate: (...args) => invokeSelectedRuntime(() => music.generate(...args)),
            listProviders: (...args) => invokeSelectedRuntime(() => music.listProviders(...args)),
          }));
        }
        if (prop === "webSearch") {
          return facades.webSearch(getRuntimeProperty(), (webSearch) => ({
            ...webSearch,
            listProviders: (...args) =>
              invokeSelectedRuntime(() => webSearch.listProviders(...args)),
            search: (...args) => invokeSelectedRuntime(() => webSearch.search(...args)),
          }));
        }
        if (prop === "tts") {
          return facades.tts(getRuntimeProperty(), (tts) => ({
            ...tts,
            prepareTtsRequest: (...args) =>
              invokeSelectedRuntime(() => tts.prepareTtsRequest(...args)),
            textToSpeech: (...args) => invokeSelectedRuntime(() => tts.textToSpeech(...args)),
            textToSpeechStream: (...args) =>
              invokeSelectedRuntime(() => tts.textToSpeechStream(...args)),
            textToSpeechTelephony: (...args) =>
              invokeSelectedRuntime(() => tts.textToSpeechTelephony(...args)),
            listVoices: (...args) => invokeSelectedRuntime(() => tts.listVoices(...args)),
          }));
        }
        if (prop === "mediaUnderstanding") {
          return facades.mediaUnderstanding(getRuntimeProperty(), (media) => ({
            ...media,
            resolveAudioInputBudget: (...args) =>
              invokeSelectedRuntime(() => media.resolveAudioInputBudget(...args)),
            runFile: (...args) => invokeSelectedRuntime(() => media.runFile(...args)),
            describeImageFile: (...args) =>
              invokeSelectedRuntime(() => media.describeImageFile(...args)),
            describeImageFileWithModel: (...args) =>
              invokeSelectedRuntime(() => media.describeImageFileWithModel(...args)),
            extractStructuredWithModel: (...args) =>
              invokeSelectedRuntime(() => media.extractStructuredWithModel(...args)),
            describeVideoFile: (...args) =>
              invokeSelectedRuntime(() => media.describeVideoFile(...args)),
            transcribeAudioFile: (...args) =>
              invokeSelectedRuntime(() => media.transcribeAudioFile(...args)),
          }));
        }
        if (prop === "modelAuth") {
          return facades.modelAuth(getRuntimeProperty(), (auth) => ({
            ...auth,
            ensureAuthProfileStore: (...args) =>
              invokeSelectedRuntime(() => auth.ensureAuthProfileStore(...args)),
            isProviderApiKeyConfigured: (...args) =>
              invokeSelectedRuntime(() => auth.isProviderApiKeyConfigured(...args)),
            getApiKeyForModel: (...args) =>
              invokeSelectedRuntime(() => auth.getApiKeyForModel(...args)),
            getRuntimeAuthForModel: (...args) =>
              invokeSelectedRuntime(() => auth.getRuntimeAuthForModel(...args)),
            resolveApiKeyForProvider: (...args) =>
              invokeSelectedRuntime(() => auth.resolveApiKeyForProvider(...args)),
          }));
        }
        if (prop === "modelConfig") {
          return facades.modelConfig(getRuntimeProperty(), (models) => ({
            ...models,
            resolveDefaultModelForAgent: (...args) =>
              invokeSelectedRuntime(() => models.resolveDefaultModelForAgent(...args)),
            resolveAllowedModelRef: (...args) =>
              invokeSelectedRuntime(() => models.resolveAllowedModelRef(...args)),
          }));
        }
        if (prop === "sandbox") {
          return facades.sandbox(getRuntimeProperty(), (sandbox) => ({
            ...sandbox,
            resolveWorkspaceAuthority: (...args) =>
              invokeSelectedRuntime(() => sandbox.resolveWorkspaceAuthority(...args)),
            prepareWorkspaceAuthority: (...args) =>
              invokeSelectedRuntime(() => sandbox.prepareWorkspaceAuthority(...args)),
          }));
        }
        if (prop === "gateway") {
          const gateway: PluginRuntime["gateway"] = getRuntimeProperty();
          const withIdentity = gateway.withUserProfileIdentity;
          const resolveGitHubAccount = gateway.resolveGitHubAccount;
          return {
            isAvailable: () => runWithPluginScope(() => gateway.isAvailable(), false),
            request: async (method, params, options) => {
              const { assertGatewaySessionRequestOwned } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertGatewaySessionRequestOwned(method, params);
                return await gateway.request(method, params, options);
              });
            },
            openPluginPanel: (params) =>
              runWithPluginScope(async () => {
                const result = await gateway.openPluginPanel(params);
                assertRuntimeCurrent();
                return result;
              }),
            readSessionFacts: (params) =>
              runWithPluginScope(async () => {
                const result = await gateway.readSessionFacts(params);
                assertRuntimeCurrent();
                return result;
              }),
            withSessionFacts: (select, run) =>
              runWithPluginScope(async () => {
                const result = await gateway.withSessionFacts(select, (snapshot) => {
                  assertRuntimeCurrent();
                  return run(snapshot);
                });
                assertRuntimeCurrent();
                return result;
              }),
            subscribeSessionChanges: (listener) =>
              runWithPluginScope(() =>
                gateway.subscribeSessionChanges((event) =>
                  runWithPluginScope(() => listener(event)),
                ),
              ),
            withUserProfileIdentity: withIdentity
              ? async (params, run) =>
                  await runWithPluginScope(async () => {
                    const result = await withIdentity(params, async (assertIdentityCurrent) => {
                      const assertCurrent = () => {
                        assertRuntimeCurrent();
                        assertIdentityCurrent();
                      };
                      assertCurrent();
                      return await run(assertCurrent);
                    });
                    assertRuntimeCurrent();
                    return result;
                  })
              : undefined,
            resolveGitHubAccount: resolveGitHubAccount
              ? (params) =>
                  runWithPluginScope(async () => {
                    const result = await resolveGitHubAccount(params);
                    assertRuntimeCurrent();
                    return result;
                  })
              : undefined,
          } satisfies PluginRuntime["gateway"];
        }
        if (prop === "hooks") {
          const hooks: PluginRuntime["hooks"] = getRuntimeProperty();
          return {
            dispatchHookAgentTurn: async (params) => {
              if (record.origin !== "bundled" && record.trustedOfficialInstall !== true) {
                throw new PluginTrustRefusalError({
                  pluginId,
                  source: record.source,
                  origin: record.origin,
                  trust: record.trust,
                });
              }
              return await runWithPluginScope(() => hooks.dispatchHookAgentTurn(params));
            },
          } satisfies PluginRuntime["hooks"];
        }
        if (prop === "nodes") {
          const nodes = getRuntimeProperty();
          return {
            list: (params) => runWithPluginScope(() => nodes.list(params)),
            invoke: (params) => runWithPluginScope(() => nodes.invoke(params)),
            openDuplex: (params) => runWithPluginScope(() => nodes.openDuplex(params)),
          } satisfies PluginRuntime["nodes"];
        }
        if (prop === "agent") {
          const agent: PluginRuntime["agent"] = getRuntimeProperty();
          if (scopedAgentRuntime?.source === agent) {
            return scopedAgentRuntime.value;
          }
          const session = agent.session;
          const scopedSession = {
            resolveStorePath: session.resolveStorePath,
            getSessionEntry: session.getSessionEntry,
            listSessionEntries: session.listSessionEntries,
            createSessionEntry: async (params) => {
              const { assertOwnedHarness, assertReservedSessionKeyOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const runtimeOwnerCount = [
                  "agentHarnessId" in params.initialEntry,
                  "cliBackendId" in params.initialEntry,
                  "acpSessionBinding" in params.initialEntry,
                ].filter(Boolean).length;
                if (runtimeOwnerCount !== 1) {
                  throw new Error(
                    `Plugin "${pluginId}" session creation requires exactly one runtime owner.`,
                  );
                }
                if ("agentHarnessId" in params.initialEntry) {
                  // Session ownership follows the registered harness capability,
                  // independently of whether the caller chooses its reserved namespace.
                  assertOwnedHarness(params.initialEntry.agentHarnessId, "create its sessions");
                  assertReservedSessionKeyOwned(params.key, "create");
                  return await session.createSessionEntry(params);
                }
                const initialEntry = params.initialEntry;
                if (!("acpSessionBinding" in initialEntry)) {
                  const backend = currentRegistry().cliBackends.find(
                    (entry) => entry.backend.id === initialEntry.cliBackendId,
                  );
                  if (!backend || backend.pluginId !== pluginId) {
                    throw new Error(
                      `Plugin "${pluginId}" must own CLI backend "${initialEntry.cliBackendId}" to create its sessions.`,
                    );
                  }
                }
                // Plugin-owned sessions stay inside a namespace that no other plugin can claim.
                if (!params.key.startsWith(`plugin:${pluginId}:`)) {
                  throw new Error(
                    `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
                  );
                }
                return await session.createSessionEntry({
                  ...params,
                  initialEntry: { ...initialEntry, pluginOwnerId: pluginId },
                });
              });
            },
            patchSessionEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "patch",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                return await session.patchSessionEntry({
                  ...params,
                  update: async (entry, context) => {
                    const patch = await params.update(entry, context);
                    assertRuntimeCurrent();
                    if (!patch) {
                      return patch;
                    }
                    const next = params.replaceEntry
                      ? (patch as SessionEntry)
                      : ({ ...entry, ...patch } satisfies SessionEntry);
                    assertStoreEntryOwned({
                      action: "patch",
                      before: context.existingEntry ?? entry,
                      entry: next,
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              });
            },
            upsertSessionEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const before = assertStoredSessionEntryOwned({
                  action: "upsert",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                assertStoreEntryOwned({
                  action: "upsert",
                  before,
                  entry: params.entry,
                  sessionKey: params.sessionKey,
                });
                await session.upsertSessionEntry(params);
              });
            },
            runWithWorkAdmission: async (params, run) => {
              const { resolveStoredSessionExecutionOwner } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const resolveCurrentExecutionOwner = () =>
                  resolveStoredSessionExecutionOwner({
                    action: "admit work on",
                    sessionKey: params.sessionKey,
                    storePath: params.storePath,
                  });
                const ownerPluginId = resolveCurrentExecutionOwner();
                const admissionSession = ownerPluginId
                  ? resolveDelegatedRuntime(ownerPluginId).agent.session
                  : session;
                return await admissionSession.runWithWorkAdmission(params, async (signal) => {
                  // Admission can wait behind another run that changes ownership.
                  // Recheck delegation inside the admitted callback before plugin work starts.
                  if (resolveCurrentExecutionOwner() !== ownerPluginId) {
                    throw new Error(
                      `Session "${params.sessionKey}" changed execution ownership while starting work.`,
                    );
                  }
                  // The owner supplies the admission primitive, but the caller's
                  // callback must not inherit the owner's plugin identity.
                  return await runWithPluginScope(() => run(signal));
                });
              });
            },
            updateSessionStoreEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "update",
                  sessionKey: params.sessionKey,
                  storePath: params.storePath,
                });
                return await session.updateSessionStoreEntry({
                  ...params,
                  update: async (entry) => {
                    const patch = await params.update(entry);
                    assertRuntimeCurrent();
                    if (!patch) {
                      return patch;
                    }
                    assertStoreEntryOwned({
                      action: "update",
                      before: entry,
                      entry: { ...entry, ...patch },
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              });
            },
          } satisfies PluginRuntime["agent"]["session"];
          const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
            const runParams = { ...params };
            const { prepareRunSessionExecution } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              const { ownerPluginId, agentHarnessRuntimeOverride } =
                prepareRunSessionExecution(runParams);
              if (agentHarnessRuntimeOverride !== undefined) {
                runParams.agentHarnessRuntimeOverride = agentHarnessRuntimeOverride;
              }
              if (ownerPluginId) {
                return await resolveDelegatedRuntime(ownerPluginId).agent.runEmbeddedAgent(
                  runParams,
                );
              }
              // The public runtime adapter owns admission preparation. Passing
              // host authority through this plugin wrapper is rejected by design.
              return await agent.runEmbeddedAgent(runParams);
            });
          };
          const runCommandFromIngress: PluginRuntime["agent"]["runCommandFromIngress"] = async (
            params,
            commandRuntime,
          ) => {
            const { senderIsOwner: claimedOwner, messageChannel, ...remainingParams } = params;
            const senderIsOwner = claimedOwner === true;
            // Validate and dispatch the same host-owned values; never re-read plugin-owned authority.
            const ingressParams = { ...remainingParams, senderIsOwner, messageChannel };
            if (
              // Community channels may admit guests; trusted provenance is required only for owner elevation.
              (senderIsOwner &&
                record.origin !== "bundled" &&
                record.trustedOfficialInstall !== true) ||
              currentRegistry().plugins.find((entry) => entry.id === pluginId) !== record ||
              !isPluginRecordActive(registry, record) ||
              !currentRegistry().channels.some(
                (channel) => channel.pluginId === pluginId && channel.plugin.id === messageChannel,
              )
            ) {
              throw new Error(
                `Plugin "${pluginId}" cannot admit authenticated owner authority for channel "${messageChannel ?? "unknown"}".`,
              );
            }
            return await runWithPluginScope(() =>
              agent.runCommandFromIngress(ingressParams, commandRuntime),
            );
          };
          const scopedAgent = Object.create(
            Object.getPrototypeOf(agent),
            Object.getOwnPropertyDescriptors(agent),
          ) as PluginRuntime["agent"];
          Object.defineProperties(scopedAgent, {
            resolveThinkingDefault: {
              configurable: true,
              enumerable: true,
              value: (params: Parameters<typeof agent.resolveThinkingDefault>[0]) =>
                invokeSelectedRuntime(() => agent.resolveThinkingDefault(params)),
            },
            resolveCliBackendDispatchEligibility: {
              configurable: true,
              enumerable: true,
              value: (params: Parameters<typeof agent.resolveCliBackendDispatchEligibility>[0]) =>
                invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibility(params)),
            },
            resolveSessionCatalogCreateTarget: {
              configurable: true,
              enumerable: true,
              value: (params: Parameters<typeof agent.resolveSessionCatalogCreateTarget>[0]) =>
                invokeSelectedRuntime(() => agent.resolveSessionCatalogCreateTarget(params)),
            },
            resolveThinkingPolicy: {
              configurable: true,
              enumerable: true,
              value: (params: Parameters<typeof agent.resolveThinkingPolicy>[0]) =>
                invokeSelectedRuntime(() => agent.resolveThinkingPolicy(params)),
            },
            runCommandFromIngress: {
              configurable: true,
              enumerable: true,
              value: runCommandFromIngress,
            },
            runEmbeddedAgent: {
              configurable: true,
              enumerable: true,
              value: runEmbeddedAgent,
            },
            session: {
              configurable: true,
              enumerable: true,
              value: scopedSession,
            },
          });
          scopedAgentRuntime = { source: agent, value: scopedAgent };
          return scopedAgent;
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        const subagent = getRuntimeProperty();
        return {
          complete: (params) => runWithPluginScope(() => subagent.complete(params)),
          run: async (params) => {
            const { assertSessionIdentitiesOwned } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              assertSessionIdentitiesOwned({
                action: "run",
                sessionKeys: [params.sessionKey],
              });
              return await subagent.run(params);
            });
          },
          waitForRun: (params) => runWithPluginScope(() => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            runWithPluginScope(() => subagent.getSessionMessages(params)),
          deleteSession: async (params) => {
            const { assertStoredSessionEntryOwned } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              assertStoredSessionEntryOwned({ action: "delete", sessionKey: params.sessionKey });
              await subagent.deleteSession(params);
            });
          },
        } satisfies PluginRuntime["subagent"];
      },
    });
    pluginRuntimes.set(record, runtime);
    return runtime;
  };

  return {
    resolvePluginRuntime,
    resolveRegisteredChannelRuntime: resolveRecordChannelRuntime,
    revokePluginRuntimeRecord: (pluginId: string, record: PluginRecord) => {
      revokePluginRecord(registry, record);
      registeredAdmissionOwnerByRecord.get(record)?.dispose();
      registeredAdmissionOwnerByRecord.delete(record);
      if (registeredRuntimeRecordById.get(pluginId) === record) {
        registeredRuntimeRecordById.delete(pluginId);
      }
    },
  };
}

export type PluginRuntimeResolver = ReturnType<typeof createPluginRuntimeResolver>;
