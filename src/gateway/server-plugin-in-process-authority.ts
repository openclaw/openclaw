import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getCanonicalGatewayContextResolver,
  getInProcessGatewayRequestContext,
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
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
  runOutsideOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
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
import { resolveRuntimeSessionParticipant } from "./session-tool-participant.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

export async function captureInProcessGatewayOperatorRunAuthority(input: {
  client: ResolvedInProcessGatewayDispatch["operatorSourceClient"];
  context: ResolvedInProcessGatewayDispatch["context"];
  hasCurrentClientAuthority?: ResolvedInProcessGatewayDispatch["hasCurrentClientAuthority"];
}) {
  const capture = input.context.createAgentTurnFacade?.captureOperatorRunAuthority;
  if (!capture) {
    throw new Error("Gateway instance operator authority capture is unavailable.");
  }
  return await capture({
    client: input.client,
    hasCurrentClientAuthority: input.hasCurrentClientAuthority,
  });
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
      ? await captureInProcessGatewayOperatorRunAuthority({
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
    authority.assertCurrent?.();
    captured?.authority.assertCurrent();
    return await runWithOperatorToolGatewayAuthority(
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
  const authority = readOperatorToolGatewayAuthority();
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
  return runOutsideOperatorToolGatewayAuthority(() =>
    withPluginRuntimeGatewayRequestScope(
      { ...scope, client, isWebchatConnect: scope?.isWebchatConnect ?? (() => false) },
      run,
    ),
  );
}

/** Captured while live; its accepting owner, not the original invocation, releases it. */
export function captureOperatorToolGatewayContinuationContext(target?: {
  sessionKey: string;
  agentId?: string;
}) {
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const resolveGatewayContext = caller?.gatewayContextResolver ?? scope?.resolveGatewayContext;
  if (!getInProcessGatewayRequestContext(resolveGatewayContext)) {
    return undefined;
  }
  // Use the normal dispatch owner to intersect scopes and validate the live caller
  // before transferring its source. A cleanup scope alone retains request lifetime.
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const resolved = resolveInProcessGatewayDispatch("agent", target, {
    forceSyntheticClient: true,
    operatorRoleActor: { kind: "system" },
    resolveGatewayContext,
    syntheticScopeMode: "exact",
  });
  return captureInProcessGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  }).then((captured) => {
    try {
      captured?.authority.assertCurrent();
      resolved.assertContextCurrent();
      resolved.assertInvocationCurrent();
      assertCallerCurrent?.("agent");
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
      const assertCurrent = () => {
        lifetime.signal.throwIfAborted();
        captured?.authority.assertCurrent();
        resolved.assertSourceCurrent();
        lifetime.signal.throwIfAborted();
      };
      return {
        assertCurrent,
        operatorAuthority: captured?.authority,
        signal: lifetime.signal,
        release,
        run<T>(run: () => T): T {
          assertCurrent();
          return withoutGatewayToolCallerIdentity(() =>
            runOutsideOperatorToolGatewayAuthority(() =>
              withPluginRuntimeGatewayRequestScope(continuationScope, run),
            ),
          );
        },
      };
    } catch (error) {
      captured?.release();
      throw error;
    }
  });
}

/** Holds the original operator source until an accepted asynchronous follow-up settles. */
export async function runWithOperatorToolGatewayContinuationContext<T>(
  run: () => Promise<T>,
): Promise<T> {
  const preparation = captureOperatorToolGatewayContinuationContext();
  if (!preparation) {
    return await runWithOperatorToolGatewayCleanupContext(run);
  }
  const captured = await preparation;
  try {
    return await captured.run(run);
  } finally {
    captured.release();
  }
}

export function resolveInProcessGatewayDispatch(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): ResolvedInProcessGatewayDispatch {
  const inheritedOperatorAuthority = readOperatorToolGatewayAuthority();
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const selection = caller?.personalToolIdentityScoped
    ? resolveGatewayToolOperatorSelection()
    : undefined;
  // Resolve the instance before capturing a target policy that must survive awaits.
  const resolveGatewayContext = options?.resolveGatewayContext ?? scope?.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  if (!context) {
    throw new Error(
      `In-process gateway dispatch requires a gateway request scope or instance binding (method: ${method}).`,
    );
  }
  const runtimeParticipant = resolveRuntimeSessionParticipant({
    method,
    requestParams: params,
    runtimeIdentity:
      readInProcessAgentRuntimeIdentity(options) ?? scope?.client?.internal?.agentRuntimeIdentity,
    context,
    connId: scope?.client?.connId,
  });
  const operatorRunAuthority =
    selection?.operatorAuthority ??
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
    selection?.assertCurrent();
    runtimeParticipant?.assertCurrent();
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
  const matchesSelectingSource =
    selection !== undefined &&
    scopedActor?.kind === "operator" &&
    scopedActor.profileId === caller?.operatorAuthority?.profileId;
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
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (options?.requireScopedClient === true && !scope?.client) {
    throw new Error(
      `In-process gateway dispatch requires an authenticated plugin request scope (method: ${method}).`,
    );
  }

  const pluginRuntimeOwnerId = normalizeOptionalString(options?.pluginRuntimeOwnerId);
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
  const selectedScopes =
    selection && operatorRunAuthority && caller?.operatorAuthority
      ? intersectOperatorScopes(operatorRunAuthority.scopes, caller.operatorAuthority.scopes)
      : operatorRunAuthority?.scopes;
  const sourceScopes =
    selectedScopes && scope?.client && (matchesOperatorSource || matchesSelectingSource)
      ? intersectOperatorScopes(selectedScopes, scope.client.connect.scopes ?? [])
      : (selectedScopes ??
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
    ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
    ...(nodeInvokeApprovalSessionKey ? { nodeInvokeApprovalSessionKey } : {}),
    pluginSubagentRequester: options?.pluginSubagentRequester,
    runtimePluginToolGrant: options?.runtimePluginToolGrant,
    pluginSubagentToolsAllow: options?.pluginSubagentToolsAllow,
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
    assertSourceCurrent,
    assertInvocationCurrent,
    assertContextCurrent: () => {
      selection?.assertCurrent();
      runtimeParticipant?.assertCurrent();
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
