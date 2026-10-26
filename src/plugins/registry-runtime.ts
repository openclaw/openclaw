import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginBlobStore,
  type OpenBlobStoreOptions,
} from "../plugin-state/plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  createPluginStateRuntimeStores,
  type OpenAsyncKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import { PluginTrustRefusalError } from "./plugin-trust.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  getPluginRegistryResourceOwner,
  isPluginRecordActive,
} from "./registry-lifecycle.js";
import {
  createRegisteredChannelRuntimeResolver,
  createScopedPluginChannelRuntime,
} from "./registry-runtime-channel.js";
import { createPluginRuntimeFacades } from "./registry-runtime-facades.js";
import { createPluginSystemRuntime } from "./registry-runtime-system.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  ExpiredPluginRegistryScopeError,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { withNativeSubagentRuntimeGuard } from "./runtime/native-subagent-context.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { PluginRegistrationMode } from "./types.js";

// A completed reaction must retain only the emptied holder, not the caller's registry closure.
function createRuntimeRegistryRelease(held: PluginRegistry[]) {
  return () => {
    held.length = 0;
  };
}

export function createPluginRuntimeResolver(state: PluginRegistryState) {
  const { registry, registryParams } = state;
  const pluginRuntimes = new WeakMap<PluginRecord, PluginRuntime>();

  const readRuntimeProperty = (record: PluginRecord, prop: PropertyKey, receiver: unknown) => {
    try {
      return Reflect.get(registryParams.runtime, prop, receiver);
    } catch (error) {
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
    }
  };
  const channelRuntime = createRegisteredChannelRuntimeResolver(state, (record) =>
    readRuntimeProperty(record, "channel", registryParams.runtime),
  );

  const resolvePluginRuntime = (
    record: PluginRecord,
    registrationMode: PluginRegistrationMode = "full",
  ): PluginRuntime => {
    const pluginId = record.id;
    const cached = registrationMode === "full" ? pluginRuntimes.get(record) : undefined;
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
    const assertNativeRuntimeCurrent = () => {
      assertRuntimeCurrent();
      if (registrationMode !== "full") {
        throw new Error(`Plugin "${pluginId}" native subagents require full registration mode.`);
      }
    };
    // Cache checks, not config or row facts; actions resolve ownership after the import settles.
    const loadSessionOwnership = createLazyRuntimeSurface(
      () => import("./registry-runtime-session-ownership.js"),
      (module) =>
        module.createPluginSessionOwnership(state, pluginId, currentRegistry, assertRuntimeCurrent),
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
    const runWithCurrentPluginScope = <T>(run: () => Promise<T>): Promise<T> =>
      runWithPluginScope(async () => {
        const result = await run();
        assertRuntimeCurrent();
        return result;
      });
    const facades = createPluginRuntimeFacades(invokeSelectedRuntime);
    let scopedAgentRuntime:
      | { source: PluginRuntime["agent"]; value: PluginRuntime["agent"] }
      | undefined;
    let scopedChannelRuntime:
      | { source: PluginRuntime["channel"]; value: PluginRuntime["channel"] }
      | undefined;
    const runtime = new Proxy(registryParams.runtime, {
      get(_target, prop, receiver) {
        const getRuntimeProperty = () => readRuntimeProperty(record, prop, receiver);
        if (prop === "capabilities") {
          const capabilities: PluginRuntime["capabilities"] = getRuntimeProperty();
          return record.contracts?.subagentProfiles?.length
            ? capabilities
            : capabilities?.filter((capability) => capability !== "native-subagent-profiles-v1");
        }
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          return {
            ...baseState,
            openBlobStore: <TMetadata>(options: OpenBlobStoreOptions) => {
              return createPluginBlobStore<TMetadata>(pluginId, options);
            },
            ...createPluginStateRuntimeStores(pluginId, assertRuntimeCurrent, () =>
              capturePluginStateOperationModuleSource(
                getPluginInstance(record),
                assertRuntimeCurrent,
              ),
            ),
            openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
              // Bind storage and operation code to the same admitted instance before yielding.
              if (options.retention === "retained") {
                assertRuntimeCurrent();
              }
              return createPluginStateKeyedStore<T>(
                record.id,
                options,
                assertRuntimeCurrent,
                capturePluginStateOperationModuleSource(
                  getPluginInstance(record),
                  assertRuntimeCurrent,
                ),
              );
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
          const readCurrent = () => runWithPluginScope(() => config.current(), false);
          function current(options: { clone: true }): OpenClawConfig;
          function current(): ReturnType<typeof readCurrent>;
          function current(options?: { clone: true }) {
            return options
              ? runWithPluginScope(() => config.current(options), false)
              : readCurrent();
          }
          return {
            ...config,
            current,
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "system") {
          return createPluginSystemRuntime({
            state,
            record,
            system: getRuntimeProperty(),
            currentRegistry,
            assertRuntimeCurrent,
            runWithPluginScope,
          });
        }
        if (prop === "channel") {
          const channel = channelRuntime.resolve(record);
          if (scopedChannelRuntime?.source === channel) {
            return scopedChannelRuntime.value;
          }
          const value = createScopedPluginChannelRuntime(
            channel,
            invokeSelectedRuntime,
            assertRuntimeCurrent,
          );
          scopedChannelRuntime = { source: channel, value };
          return value;
        }
        if (prop === "decisions") {
          return {
            evaluate: async (batch, options) => {
              assertRuntimeCurrent();
              const capturedRegistry = currentDecisionRegistry();
              const { evaluateDecisionOperation, completeDecisionEvaluation } =
                await import("../decisions/runtime.js");
              assertRuntimeCurrent();
              const selectedRegistry = currentDecisionRegistry(capturedRegistry);
              const result = await withPluginRuntimeRegistryScope(selectedRegistry, () =>
                evaluateDecisionOperation(
                  batch,
                  options,
                  selectedRegistry,
                  readRuntimeConfig(),
                  record.id,
                  () => {
                    assertRuntimeCurrent();
                    return true;
                  },
                ),
              );
              assertRuntimeCurrent();
              options.signal.throwIfAborted();
              return completeDecisionEvaluation(result);
            },
            evaluateV2: async (batch, options) => {
              assertRuntimeCurrent();
              const capturedRegistry = currentDecisionRegistry();
              const { evaluateDecisionV2Operation, completeDecisionEvaluation } =
                await import("../decisions/runtime.js");
              assertRuntimeCurrent();
              const selectedRegistry = currentDecisionRegistry(capturedRegistry);
              const config = readRuntimeConfig();
              const result = await withPluginRuntimeRegistryScope(selectedRegistry, () =>
                evaluateDecisionV2Operation(
                  batch,
                  options,
                  selectedRegistry,
                  config,
                  record.id,
                  () => {
                    assertRuntimeCurrent();
                    return true;
                  },
                ),
              );
              assertRuntimeCurrent();
              options.signal.throwIfAborted();
              return completeDecisionEvaluation(result);
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
        if (
          prop === "media" ||
          prop === "imageGeneration" ||
          prop === "videoGeneration" ||
          prop === "musicGeneration" ||
          prop === "webSearch" ||
          prop === "tts" ||
          prop === "mediaUnderstanding" ||
          prop === "modelAuth" ||
          prop === "modelConfig" ||
          prop === "sandbox"
        ) {
          return facades[prop](getRuntimeProperty());
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
                await assertGatewaySessionRequestOwned(method, params);
                return await gateway.request(method, params, options);
              });
            },
            openPluginPanel: (params) =>
              runWithCurrentPluginScope(() => gateway.openPluginPanel(params)),
            readSessionFacts: (params) =>
              runWithCurrentPluginScope(() => gateway.readSessionFacts(params)),
            appendAgentMessage: (params) =>
              runWithCurrentPluginScope(() => gateway.appendAgentMessage(params)),
            withSessionFacts: (select, run) =>
              runWithCurrentPluginScope(() =>
                gateway.withSessionFacts(select, (snapshot) => {
                  assertRuntimeCurrent();
                  return run(snapshot);
                }),
              ),
            subscribeSessionChanges: (listener) =>
              runWithPluginScope(() =>
                gateway.subscribeSessionChanges((event) =>
                  runWithPluginScope(() => listener(event)),
                ),
              ),
            withUserProfileIdentity: withIdentity
              ? async (params, run) =>
                  await runWithCurrentPluginScope(() =>
                    withIdentity(params, async (assertIdentityCurrent) => {
                      const assertCurrent = () => {
                        assertRuntimeCurrent();
                        assertIdentityCurrent();
                      };
                      assertCurrent();
                      return await run(assertCurrent);
                    }),
                  )
              : undefined,
            resolveGitHubAccount: resolveGitHubAccount
              ? (params) => runWithCurrentPluginScope(() => resolveGitHubAccount(params))
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
            getSessionEntryAsync: (params) =>
              runWithCurrentPluginScope(() => session.getSessionEntryAsync(params)),
            getSessionEntryByIdAsync: (params) =>
              runWithCurrentPluginScope(() => session.getSessionEntryByIdAsync(params)),
            listSessionEntries: session.listSessionEntries,
            listSessionEntriesAsync: (params) =>
              runWithCurrentPluginScope(() => session.listSessionEntriesAsync(params)),
            createSessionEntryListReader: (params) =>
              runWithPluginScope(async () => {
                const read = await session.createSessionEntryListReader(params);
                assertRuntimeCurrent();
                return async () =>
                  await runWithPluginScope(async () => {
                    const result = await read();
                    assertRuntimeCurrent();
                    return {
                      entries: result.entries,
                      assertCurrent: () => {
                        assertRuntimeCurrent();
                        result.assertCurrent();
                      },
                    };
                  });
              }),
            createSessionEntry: async (params) => {
              const { createSessionEntry } = await loadSessionOwnership();
              return await runWithPluginScope(() => createSessionEntry(session, params));
            },
            prepareSessionEntryPatch: async (params) => {
              const { prepareSessionEntryPatch } = await loadSessionOwnership();
              return await runWithPluginScope(() =>
                prepareSessionEntryPatch(session, params, assertRuntimeCurrent),
              );
            },
            patchSessionEntry: async (params) => {
              const { patchSessionEntry } = await loadSessionOwnership();
              return await runWithPluginScope(() =>
                patchSessionEntry(session, params, assertRuntimeCurrent),
              );
            },
            upsertSessionEntry: async (params) => {
              const { upsertSessionEntry } = await loadSessionOwnership();
              return await runWithPluginScope(() =>
                upsertSessionEntry(session, params, assertRuntimeCurrent),
              );
            },
            runWithWorkAdmission: async (params, run) => {
              const { resolveStoredSessionExecutionOwner } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const resolveCurrentExecutionOwner = () =>
                  resolveStoredSessionExecutionOwner({
                    sessionKey: params.sessionKey,
                    storePath: params.storePath,
                  });
                const ownerPluginId = await resolveCurrentExecutionOwner();
                const admissionSession = ownerPluginId
                  ? resolveDelegatedRuntime(ownerPluginId).agent.session
                  : session;
                return await admissionSession.runWithWorkAdmission(params, async (signal) => {
                  // Admission can wait behind another run that changes ownership.
                  // Recheck delegation inside the admitted callback before plugin work starts.
                  if ((await resolveCurrentExecutionOwner()) !== ownerPluginId) {
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
              const { prepareSessionStoreUpdate } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const update = await prepareSessionStoreUpdate(params, assertRuntimeCurrent);
                return await session.updateSessionStoreEntry({ ...params, update });
              });
            },
          } satisfies PluginRuntime["agent"]["session"];
          const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
            const runParams = { ...params };
            const { prepareRunSessionExecution } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              const { ownerPluginId, agentHarnessRuntimeOverride } =
                await prepareRunSessionExecution(runParams);
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
            // SAFETY: cloning the prototype and every own descriptor preserves the complete agent surface.
          ) as PluginRuntime["agent"];
          const overrides = {
            resolveThinkingDefault: (params: Parameters<typeof agent.resolveThinkingDefault>[0]) =>
              invokeSelectedRuntime(() => agent.resolveThinkingDefault(params)),
            resolveCliBackendDispatchEligibility: (
              params: Parameters<typeof agent.resolveCliBackendDispatchEligibility>[0],
            ) => invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibility(params)),
            resolveCliBackendDispatchEligibilityAsync: (
              params: Parameters<typeof agent.resolveCliBackendDispatchEligibilityAsync>[0],
            ) =>
              invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibilityAsync(params)),
            resolveSessionCatalogCreateTarget: (
              params: Parameters<typeof agent.resolveSessionCatalogCreateTarget>[0],
            ) => invokeSelectedRuntime(() => agent.resolveSessionCatalogCreateTarget(params)),
            resolveThinkingPolicy: (params: Parameters<typeof agent.resolveThinkingPolicy>[0]) =>
              invokeSelectedRuntime(() => agent.resolveThinkingPolicy(params)),
            runCommandFromIngress,
            runEmbeddedAgent,
            session: scopedSession,
          } satisfies Partial<PluginRuntime["agent"]>;
          Object.defineProperties(
            scopedAgent,
            Object.fromEntries(
              Object.entries(overrides).map(([key, value]) => [
                key,
                { configurable: true, enumerable: true, value },
              ]),
            ),
          );
          scopedAgentRuntime = { source: agent, value: scopedAgent };
          return scopedAgent;
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        const subagent: PluginRuntime["subagent"] = getRuntimeProperty();
        const native = subagent.native;
        return {
          ...(native
            ? {
                native: {
                  spawn: (params) =>
                    runWithPluginScope(() =>
                      withNativeSubagentRuntimeGuard(
                        { pluginId, assertCurrent: assertNativeRuntimeCurrent },
                        () => native.spawn(params),
                      ),
                    ),
                  collect: (params) =>
                    runWithPluginScope(() =>
                      withNativeSubagentRuntimeGuard(
                        { pluginId, assertCurrent: assertNativeRuntimeCurrent },
                        () => native.collect(params),
                      ),
                    ),
                },
              }
            : {}),
          complete: (params) => runWithPluginScope(() => subagent.complete(params)),
          forkSession: (params) => runWithPluginScope(() => subagent.forkSession(params)),
          run: async (params) => {
            const { assertSessionIdentitiesOwned } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              await assertSessionIdentitiesOwned({
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
              await assertStoredSessionEntryOwned({
                action: "delete",
                sessionKey: params.sessionKey,
              });
              await subagent.deleteSession(params);
            });
          },
        } satisfies PluginRuntime["subagent"];
      },
    });
    if (registrationMode === "full") {
      pluginRuntimes.set(record, runtime);
    }
    return runtime;
  };

  return {
    resolvePluginRuntime,
    resolveRegisteredChannelRuntime: channelRuntime.resolve,
    revokePluginRuntimeRecord: channelRuntime.revoke,
  };
}
