import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { readInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "./in-process-subagent-resume.js";
import {
  authorizeGatewaySessionCreation,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  dispatchGatewayRequestInProcessRaw,
  type GatewayMethodDispatchResponse,
  throwIfGatewayDispatchAborted,
  unwrapGatewayMethodDispatchResponse,
} from "./server-in-process-dispatch.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import type {
  DispatchGatewayMethodInProcessOptions,
  OperatorToolGatewayAuthority,
  ResolvedInProcessGatewayDispatch,
} from "./server-plugin-in-process-dispatch.types.js";
import { resolveInProcessGatewaySyntheticScopes } from "./server-plugin-in-process-scopes.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
  projectPluginRuntimeClientExecution,
} from "./server-plugin-runtime-client.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

const operatorToolGatewayAuthority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

export function readOperatorToolGatewayAuthority(): OperatorToolGatewayAuthority | undefined {
  return operatorToolGatewayAuthority.getStore();
}

/** Retains operator attribution and authority only for the awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "signal">,
  run: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  const captured =
    context && (authority.operatorRunAuthority || authority.operatorRoleActor?.kind !== "system")
      ? captureGatewayOperatorRunAuthority({
          client:
            scope?.client && !authority.operatorRunAuthority
              ? scope.client
              : createSyntheticPluginRuntimeClient({
                  authenticatedUserProfile: authority.authenticatedUserProfile,
                  operatorRoleActor: authority.operatorRoleActor,
                  operatorRunAuthority: authority.operatorRunAuthority,
                  scopes: [...authority.scopes],
                }),
          context,
          hasCurrentClientAuthority: scope?.hasCurrentClientAuthority,
        })
      : undefined;
  try {
    return await operatorToolGatewayAuthority.run(
      {
        ...authority,
        operatorRunAuthority: captured?.authority ?? authority.operatorRunAuthority,
        signal: lifetime.signal,
      },
      () =>
        captured && scope?.client
          ? withPluginRuntimeGatewayRequestScope(
              {
                ...scope,
                client: mergePluginRuntimeClientInternal(scope.client, {
                  operatorRunAuthority: captured.authority,
                }),
              },
              run,
            )
          : run(),
    );
  } finally {
    lifetime.abort(new Error("operator tool invocation authority expired"));
    captured?.release();
  }
}

/** Transfer bounded cleanup without retaining the finished operator invocation. */
export function runWithOperatorToolGatewayCleanupContext<T>(run: () => T): T {
  const authority = operatorToolGatewayAuthority.getStore();
  if (!authority) {
    return run();
  }
  authority.signal.throwIfAborted();
  const scope = getPluginRuntimeGatewayRequestScope();
  // Retain the effective actor and scopes after releasing the invocation;
  // profile attribution alone does not establish authority.
  const client = createSyntheticPluginRuntimeClient({
    authenticatedUserProfile: authority.authenticatedUserProfile,
    scopes: [...authority.scopes],
    operatorRoleActor:
      authority.operatorRoleActor ??
      scope?.client?.internal?.operatorRoleActor ??
      (authority.authenticatedUserProfile
        ? {
            kind: "operator",
            profileId: authority.authenticatedUserProfile.profileId,
          }
        : undefined),
  });
  return operatorToolGatewayAuthority.exit(() =>
    withPluginRuntimeGatewayRequestScope(
      { ...scope, client, isWebchatConnect: scope?.isWebchatConnect ?? (() => false) },
      run,
    ),
  );
}

/** Captured while live; its accepting owner, not the original invocation, releases it. */
export function captureOperatorToolGatewayContinuationContext() {
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const resolveGatewayContext = caller?.gatewayContextResolver ?? scope?.resolveGatewayContext;
  if (!getInProcessGatewayRequestContext(resolveGatewayContext)) {
    return undefined;
  }
  // Use the normal dispatch owner to intersect scopes and validate the live caller
  // before transferring its source. A cleanup scope alone retains request lifetime.
  const resolved = resolveInProcessGatewayDispatch("agent", undefined, {
    forceSyntheticClient: true,
    operatorRoleActor: { kind: "system" },
    resolveGatewayContext,
    syntheticScopeMode: "exact",
  });
  const captured = captureGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  });
  const continuationScope = runWithOperatorToolGatewayCleanupContext(() => ({
    ...getPluginRuntimeGatewayRequestScope(),
    client: captured
      ? mergePluginRuntimeClientInternal(resolved.client, {
          operatorRunAuthority: captured.authority,
        })
      : resolved.client,
    context: resolved.context,
    resolveGatewayContext,
    isWebchatConnect: resolved.isWebchatConnect,
    // The retained source still checks device/profile/role and Gateway revocation;
    // the completed request or disconnected transport no longer owns this work.
    hasCurrentClientAuthority: captured ? undefined : resolved.hasCurrentClientAuthority,
  }));
  const ownerResolver = resolved.context.resolveGatewayContext ?? resolveGatewayContext;
  const gatewayOwner = ownerResolver && getCanonicalGatewayContextResolver(ownerResolver);
  const signals = [
    captured?.authority.signal,
    gatewayOwner && getGatewayContextLifetime(gatewayOwner).signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const lifetime = new AbortController();
  const release = () => {
    if (lifetime.signal.aborted) {
      return;
    }
    lifetime.abort(new Error("Gateway continuation authority is no longer active"));
    for (const signal of signals) {
      signal.removeEventListener("abort", release);
    }
    captured?.release();
  };
  for (const signal of signals) {
    signal.addEventListener("abort", release, { once: true });
  }
  if (signals.some((signal) => signal.aborted)) {
    release();
  }
  return {
    operatorAuthority: captured?.authority,
    signal: lifetime.signal,
    release,
    run<T>(run: () => T): T {
      lifetime.signal.throwIfAborted();
      resolved.assertContextCurrent();
      captured?.authority.assertCurrent();
      return withoutGatewayToolCallerIdentity(() =>
        operatorToolGatewayAuthority.exit(() =>
          withPluginRuntimeGatewayRequestScope(continuationScope, run),
        ),
      );
    },
  };
}

/** Holds the original operator source until an accepted asynchronous follow-up settles. */
export async function runWithOperatorToolGatewayContinuationContext<T>(
  run: () => Promise<T>,
): Promise<T> {
  const captured = captureOperatorToolGatewayContinuationContext();
  if (!captured) {
    return await runWithOperatorToolGatewayCleanupContext(run);
  }
  try {
    return await captured.run(run);
  } finally {
    captured.release();
  }
}

function resolveInProcessGatewayDispatch(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): ResolvedInProcessGatewayDispatch {
  const inheritedOperatorAuthority = operatorToolGatewayAuthority.getStore();
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const operatorRunAuthority =
    caller?.operatorAuthority ??
    inheritedOperatorAuthority?.operatorRunAuthority ??
    scope?.client?.internal?.operatorRunAuthority;
  // A registered settle cohort owns its wake after the spawning tool has finished.
  // Qualify that live owner before replacing the tool lifetime at admission.
  const assertSettleWakeCurrent =
    method === "agent" ? options?.settleWakeReplay?.assertCurrent : undefined;
  const isHostOwnedAgentRun =
    method === "agent" && Boolean(options?.agentRunTracking || assertSettleWakeCurrent);
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const transfersCreatedInput =
    method === "sessions.create" &&
    options?.sessionCreation?.via === "spawn" &&
    caller?.operationalRunInstance !== undefined &&
    assertCallerCurrent !== undefined &&
    options.agentToolCaller?.agentId === caller.agentId &&
    options.agentToolCaller.sessionKey === caller.sessionKey;
  const assertInvocationCurrent = () => {
    assertSettleWakeCurrent?.();
    if (!isHostOwnedAgentRun || !operatorRunAuthority) {
      inheritedOperatorAuthority?.signal.throwIfAborted();
      inheritedOperatorAuthority?.assertCurrent?.();
    }
    operatorRunAuthority?.assertCurrent();
  };
  assertInvocationCurrent();
  if (!isHostOwnedAgentRun) {
    assertCallerCurrent?.(method);
  }
  const scopedOperatorProfile = scope?.client?.authenticatedUserProfile;
  const scopedRoleActor = scope?.client?.internal?.operatorRoleActor;
  const scopedActor = resolveGatewayOperatorRoleActor(scope?.client);
  const matchesOperatorSource =
    !operatorRunAuthority ||
    (scopedActor?.kind === "operator" && scopedActor.profileId === operatorRunAuthority.profileId);
  const explicitSystemActor =
    !scope?.client && !inheritedOperatorAuthority ? options?.operatorRoleActor : undefined;
  const verifiedOperatorAuthority =
    inheritedOperatorAuthority ??
    (scopedOperatorProfile?.profileId
      ? {
          authenticatedUserProfile: scopedOperatorProfile,
          scopes: scope?.client?.connect.scopes ?? [],
        }
      : undefined);
  // Subagent launch ownership stays with the host after its target was checked;
  // retain the verified role actor separately so target policy remains enforced.
  const operatorAuthority =
    !isHostOwnedAgentRun &&
    (!operatorRunAuthority ||
      verifiedOperatorAuthority?.authenticatedUserProfile?.profileId ===
        operatorRunAuthority.profileId)
      ? verifiedOperatorAuthority
      : undefined;
  const operatorRoleActor: GatewayOperatorRoleActor | undefined =
    (operatorRunAuthority
      ? { kind: "operator", profileId: operatorRunAuthority.profileId }
      : undefined) ??
    inheritedOperatorAuthority?.operatorRoleActor ??
    (isHostOwnedAgentRun
      ? inheritedOperatorAuthority?.authenticatedUserProfile
        ? {
            kind: "operator",
            profileId: inheritedOperatorAuthority.authenticatedUserProfile.profileId,
          }
        : (scopedRoleActor ??
          (scopedOperatorProfile?.profileId
            ? { kind: "operator", profileId: scopedOperatorProfile.profileId }
            : scope?.client
              ? undefined
              : (explicitSystemActor ?? { kind: "system" })))
      : (scopedRoleActor ?? explicitSystemActor));
  // The router installs a nested scope; retain the admitted resolver for later commit checks.
  const resolveGatewayContext = options?.resolveGatewayContext ?? scope?.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `In-process gateway dispatch requires a gateway request scope or instance binding (method: ${method}).`,
    );
  }
  if (options?.requireScopedClient === true && !scope?.client) {
    throw new Error(
      `In-process gateway dispatch requires an authenticated plugin request scope (method: ${method}).`,
    );
  }

  const pluginRuntimeOwnerId =
    typeof options?.pluginRuntimeOwnerId === "string" && options.pluginRuntimeOwnerId.trim()
      ? options.pluginRuntimeOwnerId.trim()
      : undefined;
  const pluginRecord = pluginRuntimeOwnerId
    ? getActivePluginRegistry()?.plugins.find((entry) => entry.id === pluginRuntimeOwnerId)
    : undefined;
  const nodeInvokeApprovalSessionKey =
    method === "node.invoke" &&
    scope?.pluginId?.trim() === pluginRuntimeOwnerId &&
    (scope?.pluginOrigin === "bundled" ||
      scope?.pluginTrustedOfficialInstall === true ||
      pluginRecord?.origin === "bundled" ||
      pluginRecord?.trustedOfficialInstall === true)
      ? options?.nodeInvokeApprovalSessionKey
      : undefined;
  if (
    options?.nodeInvokeStream &&
    (method !== "node.invoke" || !pluginRuntimeOwnerId || options.forceSyntheticClient !== true)
  ) {
    throw new Error("Node invoke streaming requires an owner-bound trusted synthetic client.");
  }
  const delegatedToolPolicyHandoffId = options?.delegatedToolPolicyHandoff
    ? registerSubagentCompletionToolHandoff(options.delegatedToolPolicyHandoff)
    : undefined;
  // Built-in requests retain the explicit ceiling of a positively scoped System caller.
  const scopedSystemScopes =
    options?.syntheticScopeMode !== undefined && scopedActor?.kind === "system"
      ? (scope?.client?.connect.scopes ?? [])
      : undefined;
  const sourceScopes =
    operatorRunAuthority && scope?.client && matchesOperatorSource
      ? intersectOperatorScopes(operatorRunAuthority.scopes, scope.client.connect.scopes ?? [])
      : (operatorRunAuthority?.scopes ??
        operatorAuthority?.scopes ??
        (options?.syntheticScopeMode !== undefined
          ? inheritedOperatorAuthority?.scopes
          : undefined) ??
        (operatorRoleActor?.kind === "operator"
          ? (verifiedOperatorAuthority?.scopes ?? scope?.client?.connect.scopes ?? [])
          : undefined));
  const operatorScopes =
    scopedSystemScopes && sourceScopes
      ? intersectOperatorScopes(sourceScopes, scopedSystemScopes)
      : (scopedSystemScopes ?? sourceScopes);
  const syntheticScopes = resolveInProcessGatewaySyntheticScopes({
    method,
    requestParams: params,
    syntheticScopes: options?.syntheticScopes,
    syntheticScopeMode: options?.syntheticScopeMode,
    operatorScopes,
    scopedClientScopes: scope?.client?.connect.scopes,
    registeredScope: context.getGatewayMethodRegistry?.().getScope(method),
    allowOwnSessionScope: context.getGatewayMethodRegistry?.().getSessionAccess?.(method)
      ?.allowOwnSessionScope,
  });
  const baseSyntheticClient = createSyntheticPluginRuntimeClient({
    ...(operatorAuthority
      ? { authenticatedUserProfile: operatorAuthority.authenticatedUserProfile }
      : {}),
    allowModelOverride: options?.allowSyntheticModelOverride === true,
    agentToolCaller: options?.agentToolCaller,
    agentRunTracking: options?.agentRunTracking,
    ...(operatorRoleActor ? { operatorRoleActor } : {}),
    ...(operatorRunAuthority ? { operatorRunAuthority } : {}),
    cronRunContinuation: options?.allowSyntheticCronRunContinuation === true,
    internalDeliveryMediaUrls: options?.internalDeliveryMediaUrls,
    internalDeliverySuppressText: options?.internalDeliverySuppressText,
    ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
    ...(nodeInvokeApprovalSessionKey ? { nodeInvokeApprovalSessionKey } : {}),
    ...(options?.pluginSubagentRequester
      ? { pluginSubagentRequester: options.pluginSubagentRequester }
      : {}),
    ...(options?.runtimePluginToolGrant
      ? { runtimePluginToolGrant: options.runtimePluginToolGrant }
      : {}),
    ...(options?.pluginSubagentToolsAllow
      ? { pluginSubagentToolsAllow: options.pluginSubagentToolsAllow }
      : {}),
    delegatedToolPolicyHandoffId,
    ...(options?.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
    scopes: syntheticScopes,
  });
  const scopedStreamClient = options?.nodeInvokeStream ? scope?.client : undefined;
  const syntheticClient = projectPluginRuntimeClientExecution({
    client: baseSyntheticClient,
    streamClient: scopedStreamClient,
    identity: readInProcessAgentRuntimeIdentity(options),
    nodeInvokeStream: options?.nodeInvokeStream,
  });
  const scopedClient = mergePluginRuntimeClientInternal(
    scope?.client,
    pluginRuntimeOwnerId ||
      options?.agentRunTracking ||
      options?.pluginSubagentRequester ||
      options?.runtimePluginToolGrant ||
      options?.pluginSubagentToolsAllow ||
      options?.delegatedToolPolicyHandoff ||
      scope?.client?.internal?.delegatedToolPolicyHandoffId
      ? {
          ...(options?.agentRunTracking ? { agentRunTracking: options.agentRunTracking } : {}),
          ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
          ...(options?.pluginSubagentRequester
            ? { pluginSubagentRequester: options.pluginSubagentRequester }
            : {}),
          runtimePluginToolGrant: options?.runtimePluginToolGrant,
          pluginSubagentToolsAllow: options?.pluginSubagentToolsAllow,
          delegatedToolPolicyHandoffId,
        }
      : undefined,
  );
  if (options?.disableSyntheticClient === true && (!scopedClient || !matchesOperatorSource)) {
    cancelSubagentCompletionToolHandoff(delegatedToolPolicyHandoffId);
    throw new Error(`In-process gateway dispatch requires a scoped client (method: ${method}).`);
  }
  const useScopedClient =
    options?.forceSyntheticClient !== true && scopedClient && matchesOperatorSource;
  const client = useScopedClient
    ? operatorRunAuthority
      ? mergePluginRuntimeClientInternal(
          scopedClient,
          undefined,
          intersectOperatorScopes(scopedClient.connect.scopes ?? [], operatorRunAuthority.scopes),
        )
      : scopedClient
    : syntheticClient;
  const resume = readInProcessSubagentResume(options);
  if (resume) {
    if (method !== "agent" || options?.forceSyntheticClient !== true || !client.internal) {
      throw new Error("Task resume requires a synthetic agent admission.");
    }
    bindInProcessSubagentResume(client.internal, resume);
  }
  const assertSourceCurrent = () => {
    operatorRunAuthority?.assertCurrent();
    if ((resolveGatewayContext ? resolveGatewayContext() : scope?.context) !== context) {
      throw new Error(
        `In-process gateway dispatch requires a current gateway instance binding (method: ${method}).`,
      );
    }
  };
  return {
    assertInvocationCurrent,
    assertContextCurrent: () => {
      assertSourceCurrent();
      if (method !== "agent") {
        assertCallerCurrent?.(method);
      }
    },
    ...(transfersCreatedInput ? { assertCreatedInputSourceCurrent: assertSourceCurrent } : {}),
    client,
    context,
    delegatedToolPolicyHandoffId,
    isWebchatConnect,
    operatorSourceClient: operatorRunAuthority
      ? { ...client, internal: { ...client.internal, operatorRunAuthority } }
      : inheritedOperatorAuthority
        ? createSyntheticPluginRuntimeClient({
            authenticatedUserProfile: inheritedOperatorAuthority.authenticatedUserProfile,
            operatorRoleActor: inheritedOperatorAuthority.operatorRoleActor,
            scopes: [...inheritedOperatorAuthority.scopes],
          })
        : (scope?.client ?? client),
    hasCurrentClientAuthority:
      options?.hasCurrentClientAuthority ??
      (operatorRunAuthority && !useScopedClient ? undefined : scope?.hasCurrentClientAuthority),
  };
}

/** Authorizes a sessionless agent execution against its captured Gateway and caller. */
export function prepareInProcessAgentExecution(params: {
  agentId: string;
  pluginRuntimeOwnerId: string;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const inheritedAuthority = operatorToolGatewayAuthority.getStore();
  const resolved = resolveInProcessGatewayDispatch(
    "agent",
    { agentId: params.agentId },
    {
      agentRunTracking: "plugin_subagent",
      pluginRuntimeOwnerId: params.pluginRuntimeOwnerId,
      resolveGatewayContext: params.resolveGatewayContext,
    },
  );
  // Profile verification updates the original connection. Sessionless work needs
  // that live principal, not the dispatch copy carrying session tracking metadata.
  const client = getPluginRuntimeGatewayRequestScope()?.client ?? resolved.client;
  let operatorSource = captureGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  });
  const assertLifetime = () => {
    resolved.assertContextCurrent();
    resolved.assertInvocationCurrent();
    operatorSource?.authority.assertCurrent();
  };
  const assertCurrent = () => {
    assertLifetime();
    const error = authorizeGatewaySessionCreation({
      cfg: resolved.context.getRuntimeConfig(),
      agentId: params.agentId,
      client,
    });
    if (error) {
      unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
    }
  };
  return {
    context: resolved.context,
    get operatorAuthority() {
      return operatorSource?.authority;
    },
    get signal() {
      return operatorSource?.authority.signal
        ? inheritedAuthority
          ? AbortSignal.any([inheritedAuthority.signal, operatorSource.authority.signal])
          : operatorSource.authority.signal
        : inheritedAuthority?.signal;
    },
    release: () => operatorSource?.release(),
    assertCurrent,
    async authorize() {
      assertLifetime();
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      assertLifetime();
      const { error } = await authorizeGatewayRequestPreDispatch({
        method: "agent",
        requestParams: { agentId: params.agentId },
        client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
      });
      assertLifetime();
      if (error) {
        unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
      }
      operatorSource ??= captureGatewayOperatorRunAuthority({
        client,
        context: resolved.context,
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
      });
      assertCurrent();
    },
    run<T>(run: () => Promise<T>): Promise<T> {
      assertCurrent();
      return operatorToolGatewayAuthority.exit(run);
    },
  };
}

async function withInProcessGatewayDispatch<T>(
  method: string,
  params: unknown,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  run: (resolved: ResolvedInProcessGatewayDispatch) => Promise<T>,
): Promise<T> {
  const resolved = resolveInProcessGatewayDispatch(method, params, options);
  let releaseOperatorAuthority: (() => void) | undefined;
  try {
    const captured = captureGatewayOperatorRunAuthority({
      client: resolved.operatorSourceClient,
      context: resolved.context,
      hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
    });
    if (captured) {
      releaseOperatorAuthority = captured.release;
      resolved.client = mergePluginRuntimeClientInternal(resolved.client, {
        operatorRunAuthority: captured.authority,
      });
      const assertContextCurrent = resolved.assertContextCurrent;
      resolved.assertContextCurrent = () => {
        assertContextCurrent();
        captured.authority.assertCurrent();
      };
      const assertCreatedInputSourceCurrent = resolved.assertCreatedInputSourceCurrent;
      if (assertCreatedInputSourceCurrent) {
        resolved.assertCreatedInputSourceCurrent = () => {
          assertCreatedInputSourceCurrent();
          captured.authority.assertCurrent();
        };
      }
    }
    // A launched agent is autonomous; retaining tool-call AsyncLocalStorage would
    // leak the human authority into later model-selected work after closure.
    return method === "agent" && operatorToolGatewayAuthority.getStore()
      ? await operatorToolGatewayAuthority.exit(() => run(resolved))
      : await run(resolved);
  } finally {
    releaseOperatorAuthority?.();
    cancelSubagentCompletionToolHandoff(resolved.delegatedToolPolicyHandoffId);
  }
}

export type { GatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

export async function dispatchGatewayMethodInProcessRaw(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<GatewayMethodDispatchResponse> {
  return await withInProcessGatewayDispatch(method, params, options, async (resolved) => {
    const assertExplicitRequestCurrent = () => {
      throwIfGatewayDispatchAborted(method, options?.signal);
      if (resolved.hasCurrentClientAuthority?.() === false) {
        throw new Error(`Gateway client authority closed before dispatching ${method}.`);
      }
      options?.sessionMutationCommitGuard?.();
    };
    const assertCreatedInputSourceCurrent = resolved.assertCreatedInputSourceCurrent;
    return await dispatchGatewayRequestInProcessRaw(method, params, {
      client: resolved.client,
      context: resolved.context,
      expectFinal: options?.expectFinal,
      isWebchatConnect: resolved.isWebchatConnect,
      hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
      methodRegistry: resolved.context.getGatewayMethodRegistry?.(),
      onAccepted: options?.onAccepted,
      onExecution: options?.onExecution,
      onSignalAbort: options?.onSignalAbort,
      requestIdPrefix: "plugin-subagent",
      sessionMutationCommitGuard: () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
        // Nested RPCs keep the original request owner through preparation and final I/O.
        assertExplicitRequestCurrent();
      },
      ...(assertCreatedInputSourceCurrent
        ? {
            assertCreatedInputSourceCurrent: () => {
              assertCreatedInputSourceCurrent();
              assertExplicitRequestCurrent();
            },
          }
        : {}),
      timeoutMs: options?.timeoutMs,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  });
}

/** Live request context for trusted built-in tools that need direct runtime state. */
export function getInProcessGatewayRequestContext(
  resolveGatewayContext?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  if (resolveGatewayContext) {
    return resolveGatewayContext();
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
}

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  if (method === "agent" || method === "agent.wait") {
    return await withInProcessGatewayDispatch(method, params, options, async (resolved) => {
      const createAgentTurnFacade = resolved.context.createAgentTurnFacade;
      if (!createAgentTurnFacade) {
        throw new Error(`Gateway instance agent turn facade unavailable for ${method}`);
      }
      // Plugins may load through another source/bundle graph. Only the captured host can
      // create turns against its published runtime; a local import creates a second owner.
      const facade = await createAgentTurnFacade({
        assertContextCurrent: resolved.assertContextCurrent,
        client: resolved.client,
        isWebchatConnect: resolved.isWebchatConnect,
      });
      return method === "agent"
        ? await facade.dispatch<T>(params as AgentRunRequest, {
            assertAdmissionCurrent: () => {
              resolved.assertInvocationCurrent();
              options?.sessionMutationCommitGuard?.();
            },
            privateCompletion: options?.privateCompletion,
            settleWakeReplay: options?.settleWakeReplay,
            cancelOnDeadline: options?.cancelOnDeadline,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
            onExecutionStarted: options?.onExecutionStarted,
            onSignalAbort: options?.onSignalAbort,
            signal: options?.signal,
            timeoutMs: options?.timeoutMs,
          })
        : await facade.wait<T>(
            params as AgentWaitParams,
            options?.timeoutMs,
            options?.signal,
            options?.onSignalAbort,
          );
    });
  }
  const response = await dispatchGatewayMethodInProcessRaw(method, params, options);
  return unwrapGatewayMethodDispatchResponse(method, response) as T;
}
