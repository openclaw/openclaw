import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import type {
  ChannelPluginLoadIntent,
  PluginLoadOptions,
  PluginRuntimeRecovery,
} from "../plugins/loader-types.js";
import { loadOpenClawPluginsAsync } from "../plugins/loader.js";
import { loadPluginLookUpTable, type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  setPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { subscribeRuntimeSessionChanges } from "../plugins/runtime/session-changes.js";
import type {
  CreatePluginRuntimeOptions,
  PluginRuntime,
  RuntimeGatewayRequestOptions,
} from "../plugins/runtime/types.js";
import { bindInProcessSessionDeliveryGeneration } from "./in-process-session-delivery.js";
import { authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import { normalizeOperatorScopeList } from "./operator-scopes.js";
import type { GatewayNodeInvokeStream } from "./server-methods/shared-types.js";
import type { GatewayContextResolver, GatewayRequestHandler } from "./server-methods/types.js";
import { resolveTrustedPluginGitHubAccount } from "./server-plugin-github-account.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
} from "./server-plugin-in-process-dispatch.js";
import {
  readTrustedPluginSessionFacts,
  withTrustedPluginSessionFacts,
} from "./server-plugin-session-facts.js";
import {
  canTrustedOfficialPluginRequestScopes,
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
  type PluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";
import { withTrustedPluginUserProfileIdentity } from "./server-plugin-user-profile.js";
import {
  hasInProcessGatewayContext,
  openGatewayNodeDuplex,
  projectGatewayRuntimeNodes,
} from "./server-plugins-node-runtime.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";

export {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
};
export type { GatewayMethodDispatchResponse } from "./server-plugin-in-process-dispatch.js";
export { runWithOperatorToolGatewayCleanupContext } from "./server-plugin-in-process-dispatch.js";
export { hasInProcessGatewayContext } from "./server-plugins-node-runtime.js";
export {
  readTrustedPluginSessionFacts,
  withTrustedPluginSessionFacts,
  withTrustedPluginUserProfileIdentity,
  resolveTrustedPluginGitHubAccount,
};
export { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

export async function dispatchTrustedPluginGatewayMethod<T>(
  method: string,
  params: Record<string, unknown> = {},
  options?: RuntimeGatewayRequestOptions,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId = scope?.pluginId?.trim();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error(
      `Gateway requests are only available to bundled or trusted official plugins. ${
        pluginId ? `Plugin "${pluginId}" is neither.` : "This call carries no plugin identity."
      } See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-gateway`,
    );
  }
  const syntheticScopes = normalizeOperatorScopeList(options?.scopes);
  let requestParams = params;
  const expectedSession = options?.sessionDeliveryGeneration;
  if (expectedSession) {
    if (method !== "send") {
      throw new Error("Session delivery generation is only valid for Gateway send requests");
    }
    const context = getInProcessGatewayRequestContext(resolveGatewayContext);
    if (!context) {
      throw new Error("Session delivery generation requires an active Gateway");
    }
    const projection = requireSessionRowProjection(context);
    const generation = await withReadySessionRows(
      projection,
      (cfg) => {
        const requested = resolveRequestedSessionAgentId(cfg, expectedSession.sessionKey);
        return requested.ok
          ? [{ key: expectedSession.sessionKey, agentId: requested.agentId }]
          : [];
      },
      (read) => {
        const requested = resolveRequestedSessionAgentId(
          read.state.cfg,
          expectedSession.sessionKey,
        );
        const record = requested.ok
          ? read.describe({ key: expectedSession.sessionKey, agentId: requested.agentId })
          : undefined;
        if (
          !record?.entry.sessionId ||
          record.entry.sessionId !== expectedSession.sessionId ||
          (record.entry.lifecycleRevision ?? undefined) !== expectedSession.lifecycleRevision
        ) {
          throw new Error("Requester session changed during delivery");
        }
        return {
          agentId: record.agentId,
          storePath: record.storeTarget.storePath,
          sessionKey: record.key,
          sessionId: record.entry.sessionId,
          lifecycleRevision: record.entry.lifecycleRevision ?? null,
        };
      },
    );
    requestParams = bindInProcessSessionDeliveryGeneration(params, generation);
  }
  return await dispatchGatewayMethodInProcess<T>(method, requestParams, {
    forceSyntheticClient: true,
    pluginRuntimeOwnerId: pluginId,
    resolveGatewayContext,
    ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    ...(syntheticScopes ? { syntheticScopes } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Narrow requester-only presentation capability; unlike arbitrary RPC it grants no plugin scopes. */
export async function openPluginPanelForRequester(
  params: Parameters<PluginRuntime["gateway"]["openPluginPanel"]>[0],
  resolveGatewayContext?: GatewayContextResolver,
): Promise<{ ok: true }> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const registry = scope?.pluginRegistry;
  const record = registry?.plugins.find((candidate) => candidate.id === scope?.pluginId);
  if (!registry || !record) {
    throw new Error("Opening a plugin panel requires a current plugin runtime.");
  }
  const live = capturePluginLifecycleAuthority(registry, record, { admittedRuntime: true });
  const assertCurrent = () => {
    scope?.signal?.throwIfAborted();
    if (!live?.()) {
      throw new Error("Opening a plugin panel requires a current plugin runtime.");
    }
  };
  assertCurrent();
  return await dispatchGatewayMethodInProcess<{ ok: true }>(
    "ui.command",
    {
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      command: {
        kind: "panel",
        panel: "plugin",
        pluginId: record.id,
        panelId: params.panelId,
        open: true,
      },
    },
    {
      pluginRuntimeOwnerId: record.id,
      resolveGatewayContext,
      syntheticScopeMode: "minimum",
      sessionMutationCommitGuard: assertCurrent,
    },
  );
}

type GatewayRuntimeNodes = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];

export function createGatewayNodesRuntime(
  resolveGatewayContext?: GatewayContextResolver,
  runtimeLifetime?: AbortSignal,
): PluginRuntime["nodes"] {
  const invokeNode = async (
    params: Parameters<PluginRuntime["nodes"]["invoke"]>[0],
    stream?: GatewayNodeInvokeStream,
    signal = params.signal,
  ) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    const pluginId = scope?.pluginId?.trim() || undefined;
    const normalizedScopes = normalizeOperatorScopeList(params.scopes);
    // Requested scopes may replace caller scopes, so only trusted plugins qualify.
    const requestedScopes = canTrustedOfficialPluginRequestScopes({ ...scope, pluginId })
      ? normalizedScopes
      : undefined;
    const callerScopes =
      stream && scope?.client
        ? (normalizeOperatorScopeList(scope.client.connect.scopes) ?? [])
        : undefined;
    if (
      callerScopes &&
      requestedScopes?.some(
        (requestedScope) =>
          !authorizeOperatorScopesForRequiredScope(requestedScope, callerScopes).allowed,
      )
    ) {
      throw new Error("Requested node scopes exceed the authenticated Gateway caller's authority.");
    }
    // Forced synthetic stream clients must retain their authenticated caller's exact scopes.
    const syntheticScopes = requestedScopes ?? callerScopes;
    return dispatchGatewayMethodInProcess<unknown>(
      "node.invoke",
      {
        nodeId: params.nodeId,
        command: params.command,
        ...(params.params !== undefined && { params: params.params }),
        timeoutMs: params.timeoutMs,
        idempotencyKey: params.idempotencyKey || randomUUID(),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
      {
        ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
        nodeInvokeApprovalSessionKey: params.sessionKey,
        ...(syntheticScopes ? { syntheticScopes } : {}),
        ...(stream || syntheticScopes ? { forceSyntheticClient: true } : {}),
        ...(stream ? { nodeInvokeStream: stream } : {}),
        ...(signal ? { signal } : {}),
        resolveGatewayContext,
      },
    );
  };

  return {
    async list(params) {
      const context = getInProcessGatewayRequestContext(resolveGatewayContext);
      const payload = await dispatchGatewayMethodInProcess<{ nodes?: unknown[] }>(
        "node.list",
        {},
        {
          resolveGatewayContext: () => context,
        },
      );
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const filteredNodes =
        params?.connected === true
          ? nodes.filter(
              (node) =>
                typeof node === "object" &&
                (node as { connected?: unknown } | null)?.connected === true,
            )
          : nodes;
      return { nodes: projectGatewayRuntimeNodes(filteredNodes, context) as GatewayRuntimeNodes };
    },
    invoke: invokeNode,
    openDuplex: (params) =>
      openGatewayNodeDuplex({ params, invokeNode, resolveGatewayContext, runtimeLifetime }),
  };
}

function createGatewayPluginRuntimeBindings(
  resolveGatewayContext: GatewayContextResolver | undefined,
  overridePolicies: PluginSubagentOverridePolicies,
): {
  runtime: Pick<PluginRuntime, "gateway" | "hooks" | "nodes" | "subagent"> &
    Pick<CreatePluginRuntimeOptions, "dispatchReplyFromConfig">;
  retire: () => void;
} {
  const lifetime = new AbortController();
  const signal = resolveGatewayContext
    ? AbortSignal.any([lifetime.signal, getGatewayContextLifetime(resolveGatewayContext).signal])
    : lifetime.signal;
  const resolveBoundGatewayContext = resolveGatewayContext
    ? () => (signal.aborted ? undefined : resolveGatewayContext())
    : undefined;
  if (resolveBoundGatewayContext) {
    bindGatewayContextResolver(resolveBoundGatewayContext, resolveGatewayContext);
  }
  return {
    retire: () => {
      lifetime.abort(new Error("Plugin Gateway runtime retired; duplex invocation cancelled."));
    },
    runtime: {
      dispatchReplyFromConfig: async (params) => {
        const { dispatchLowLevelChannelReplyFromConfig } =
          await import("../auto-reply/reply/dispatch-from-config.js");
        const sessionWorkerPlacementContext = getInProcessGatewayRequestContext(
          resolveBoundGatewayContext,
        );
        const run = async () =>
          await dispatchLowLevelChannelReplyFromConfig({
            ...params,
            ...(sessionWorkerPlacementContext ? { sessionWorkerPlacementContext } : {}),
          });
        return resolveBoundGatewayContext
          ? await withPluginRuntimeGatewayContextResolver(resolveBoundGatewayContext, run)
          : await run();
      },
      gateway: {
        isAvailable: async () => hasInProcessGatewayContext(resolveBoundGatewayContext),
        request: (method, params, options) =>
          dispatchTrustedPluginGatewayMethod(method, params, options, resolveBoundGatewayContext),
        openPluginPanel: (params) =>
          openPluginPanelForRequester(params, resolveBoundGatewayContext),
        readSessionFacts: (params) =>
          readTrustedPluginSessionFacts(params, resolveBoundGatewayContext),
        withSessionFacts: (select, run) =>
          withTrustedPluginSessionFacts(select, run, resolveBoundGatewayContext),
        subscribeSessionChanges: subscribeRuntimeSessionChanges,
        withUserProfileIdentity: (params, run) =>
          withTrustedPluginUserProfileIdentity(params, run, resolveBoundGatewayContext),
        resolveGitHubAccount: (params) =>
          resolveTrustedPluginGitHubAccount(
            {
              ...params,
              signal: params.signal ? AbortSignal.any([params.signal, signal]) : signal,
            },
            resolveBoundGatewayContext,
          ),
      },
      hooks: {
        dispatchHookAgentTurn: async (params) => {
          const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
          const gatewayContext = resolveBoundGatewayContext?.();
          if (!pluginId || !gatewayContext?.dispatchHookAgentTurn) {
            throw new Error("Plugin hook runtime requires an active Gateway and plugin identity.");
          }
          return await gatewayContext.dispatchHookAgentTurn(pluginId, params);
        },
      },
      nodes: createGatewayNodesRuntime(resolveBoundGatewayContext, signal),
      subagent: createGatewaySubagentRuntime(resolveBoundGatewayContext, overridePolicies, signal),
    },
  };
}

export async function loadGatewayPlugins(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  baseMethods: string[];
  pluginIds?: string[];
  pluginLookUpTable?: PluginLookUpTable;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  channelPluginLoadIntent?: ChannelPluginLoadIntent;
  suppressPluginInfoLogs?: boolean;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
  loadIntent: "startup" | "replacement";
  previousRegistry?: import("../plugins/registry-types.js").PluginRegistry;
  replacePluginIds?: ReadonlySet<string>;
  expectedSourceDigests?: Readonly<Record<string, string>>;
  /** Metadata-only replacement preflight; never executes plugin registration. */
  loadModules?: boolean;
  moduleRecoveries?: ReadonlyMap<string, PluginRuntimeRecovery>;
  prepareRegistrationFailureCleanup?: PluginLoadOptions["prepareRegistrationFailureCleanup"];
  env?: NodeJS.ProcessEnv;
}) {
  const started = performance.now();
  const allowProcessHomeSessionCatalogs = allowsProcessHomeSessionScan();
  const resolvedConfig = params.cfg;
  const pluginIds = params.pluginIds ?? [
    ...(
      params.pluginLookUpTable ??
      loadPluginLookUpTable({
        config: resolvedConfig,
        activationSourceConfig: params.activationSourceConfig,
        workspaceDir: params.workspaceDir,
        env: params.env ?? process.env,
        ambientEnvTriggers: params.ambientEnvTriggers,
      })
    ).startup.pluginIds,
  ];
  const pluginIdsMs = performance.now() - started;
  const metadataSnapshot =
    params.pluginMetadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    });
  const loaderMetadata = metadataSnapshot ?? params.pluginLookUpTable;
  const logger = {
    ...createPluginRuntimeLoaderLogger(),
    ...(params.suppressPluginInfoLogs ? { info: () => undefined } : {}),
  };
  const loadContext: PluginRuntimeLoadContext = {
    rawConfig: params.cfg,
    config: resolvedConfig,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: params.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
    logger,
    preferBuiltPluginArtifacts: true,
    expectedSourceDigests: params.expectedSourceDigests,
    metadataSnapshot,
    ...(loaderMetadata
      ? {
          manifestRegistry: loaderMetadata.manifestRegistry,
          installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(loaderMetadata.index),
        }
      : {}),
  };
  const beforeLoad = performance.now();
  const loaderStatsBefore = getPluginModuleLoaderStats();
  const gatewayRuntimeBindings = pluginIds.length
    ? createGatewayPluginRuntimeBindings(
        params.resolveGatewayContext,
        resolvePluginSubagentOverridePolicies(resolvedConfig),
      )
    : undefined;
  let pluginRegistry: Awaited<ReturnType<typeof loadOpenClawPluginsAsync>>;
  try {
    pluginRegistry = gatewayRuntimeBindings
      ? await loadOpenClawPluginsAsync({
          ...buildPluginRuntimeLoadOptions(loadContext),
          activate: false,
          runtimeSideEffects: true,
          cache: false,
          throwOnLoadError: params.loadIntent === "replacement",
          previousRegistry: params.previousRegistry,
          replacePluginIds: params.replacePluginIds ? [...params.replacePluginIds] : undefined,
          loadModules: params.loadModules,
          moduleRecoveries: params.moduleRecoveries,
          prepareRegistrationFailureCleanup: params.prepareRegistrationFailureCleanup,
          // Startup registration stays scoped; later capability loads use the complete bound generation.
          manifestRegistry:
            params.pluginLookUpTable?.manifestRegistry ?? loadContext.manifestRegistry,
          allowProcessHomeSessionCatalogs,
          onlyPluginIds: pluginIds,
          coreGatewayHandlers: params.coreGatewayHandlers,
          coreGatewayMethodNames: params.coreGatewayMethodNames,
          hostServices: params.hostServices,
          runtimeOptions: {
            allowGatewaySubagentBinding: true,
            ...gatewayRuntimeBindings.runtime,
          },
          channelPluginLoadIntent: params.channelPluginLoadIntent,
          startupTrace: params.startupTrace,
        })
      : createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(pluginRegistry, loadContext);
  } catch (error) {
    gatewayRuntimeBindings?.retire();
    throw error;
  }
  const loadMs = performance.now() - beforeLoad;
  const loaderStatsAfter = getPluginModuleLoaderStats();
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = uniqueStrings([...params.baseMethods, ...pluginMethods]);
  params.startupTrace?.detail("plugins.gateway-load", [
    ["pluginIdsMs", pluginIdsMs],
    ["loadMs", loadMs],
    ["pluginIds", String(pluginIds.length)],
    ["pluginCount", pluginIds.length],
    ["gatewayHandlers", String(pluginMethods.length)],
    ["gatewayHandlerCount", pluginMethods.length],
    ["loaderCallsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
    ["loaderNativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
    ["loaderNativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
    [
      "loaderSourceTransformForcedCount",
      loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced,
    ],
    [
      "loaderSourceTransformFallbacksCount",
      loaderStatsAfter.sourceTransformFallbacks - loaderStatsBefore.sourceTransformFallbacks,
    ],
    [
      "loaderTopSourceTransformTargets",
      loaderStatsAfter.topSourceTransformTargets
        .slice(0, 3)
        .map((entry) => `${entry.count}:${entry.target}`)
        .join(","),
    ],
  ]);
  return {
    pluginRegistry,
    gatewayMethods,
    retireGatewayRuntimeBindings: gatewayRuntimeBindings?.retire ?? (() => {}),
  };
}
