import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  composePreparedOnlySessionSource,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { isHostPluginApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getCanonicalGatewayContextResolver,
  getInProcessGatewayRequestContext,
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { assertParticipationGatewayMethod } from "../security/dangerous-tools.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "./in-process-subagent-resume.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { captureGatewayOperatorContinuation } from "./operator-run-recovery.js";
import { WRITE_SCOPE } from "./operator-scopes.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
  runOutsideOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import { resolvePluginSessionWorkDispatch } from "./plugin-session-work-authority.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type {
  DispatchGatewayMethodInProcessOptions,
  OperatorContinuationOptions,
  OperatorToolGatewayAuthority,
  ResolvedInProcessGatewayDispatch,
} from "./server-plugin-in-process-dispatch.types.js";
import { resolveInProcessSyntheticScopes } from "./server-plugin-in-process-scopes.js";
import { resolveSystemScopeCeiling } from "./server-plugin-in-process-system-ceiling.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
  projectPluginRuntimeClientExecution,
  runWithOperatorToolGatewayCleanupContext,
} from "./server-plugin-runtime-client.js";
import { createSessionContinuationLifetime } from "./session-continuation-lifetime.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

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
      ? await prepareGatewayOperatorRunAuthority({
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

export function captureOperatorToolGatewayContinuationContextInternal(
  target?: { sessionKey: string; agentId?: string },
  options?: OperatorContinuationOptions & {
    request?: { method: string; params: Record<string, unknown> };
  },
) {
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const requester =
    options?.retainRequester && caller
      ? {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          origin: resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true })
            .requesterOrigin,
        }
      : undefined;
  const resolveGatewayContext = caller?.gatewayContextResolver ?? scope?.resolveGatewayContext;
  if (!getInProcessGatewayRequestContext(resolveGatewayContext)) {
    return undefined;
  }
  // Use the normal dispatch owner to intersect scopes and validate the live caller
  // before transferring its source. A cleanup scope alone retains request lifetime.
  const method = options?.request?.method ?? "agent";
  if (options?.request && method !== "plugins.reload") {
    throw new Error("Request-bound continuation only supports plugin reload");
  }
  const requestParams = options?.request?.params ?? target;
  const resolved = resolveInProcessGatewayDispatch(method, requestParams, {
    forceSyntheticClient: true,
    operatorRoleActor: { kind: "system" },
    resolveGatewayContext,
    ...(options?.request
      ? {
          syntheticScopes: resolveLeastPrivilegeOperatorScopesForMethod(method, requestParams),
          syntheticScopeMode: "minimum" as const,
        }
      : { syntheticScopeMode: "exact" as const }),
  });
  return prepareGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  }).then((captured) => {
    try {
      resolved.assertContextCurrent();
      resolved.assertInvocationCurrent();
      for (const signal of caller?.approvalSignals ?? []) {
        signal.throwIfAborted();
      }
      const continuationScope = runWithOperatorToolGatewayCleanupContext(() => ({
        ...getPluginRuntimeGatewayRequestScope(),
        client: captured
          ? mergePluginRuntimeClientInternal(
              resolved.client,
              { operatorRunAuthority: captured.authority },
              intersectOperatorScopes(
                resolved.client.connect.scopes ?? [],
                captured.authority.scopes,
              ),
            )
          : resolved.client,
        context: resolved.context,
        resolveGatewayContext,
        isWebchatConnect: resolved.isWebchatConnect,
        // Transfer requester custody independently of the completed invocation.
        hasCurrentClientAuthority: captured ? undefined : resolved.hasCurrentClientAuthority,
      }));
      const ownerResolver = resolved.context.resolveGatewayContext ?? resolveGatewayContext;
      const gatewayOwner = ownerResolver && getCanonicalGatewayContextResolver(ownerResolver);
      const signals = [
        captured?.authority.signal,
        gatewayOwner && getGatewayContextLifetime(gatewayOwner).signal,
      ].filter((signal): signal is AbortSignal => Boolean(signal));
      const lifetime = createSessionContinuationLifetime(target, gatewayOwner);
      const release = () => {
        if (lifetime.signal.aborted) {
          return;
        }
        lifetime.abort(new Error("Gateway continuation ended. Start a new request."));
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
        if (captured) {
          resolved.assertGatewayCurrent();
        } else {
          resolved.assertSourceCurrent();
        }
      };
      const runInScope = <T>(run: () => T): T => {
        assertCurrent();
        return withoutGatewayToolCallerIdentity(() =>
          runOutsideOperatorToolGatewayAuthority(() =>
            withPluginRuntimeGatewayRequestScope(continuationScope, run),
          ),
        );
      };
      return {
        assertCurrent,
        operatorAuthority: captured?.authority,
        scopes: resolved.client.connect.scopes,
        requesterOrigin: requester?.origin,
        signal: lifetime.signal,
        release,
        run: runInScope,
        /** Re-enter only the requester selected before transfer, under this retained source. */
        async runWithRequester<T>(run: () => Promise<T>, agentId?: string): Promise<T> {
          assertCurrent();
          const admitted = await captureGatewayOperatorContinuation({
            agentId: agentId ?? target?.agentId,
            client: continuationScope.client ?? null,
            context: resolved.context,
          });
          try {
            return await runInScope(() =>
              withPluginRuntimeGatewayRequestScope(
                {
                  ...continuationScope,
                  client: admitted
                    ? mergePluginRuntimeClientInternal(
                        resolved.client,
                        { operatorRunAuthority: admitted.authority },
                        intersectOperatorScopes(
                          resolved.client.connect.scopes ?? [],
                          admitted.authority.scopes,
                        ),
                      )
                    : continuationScope.client,
                },
                () =>
                  requester
                    ? withGatewayToolCallerIdentity(
                        {
                          agentId: requester.agentId,
                          sessionKey: requester.sessionKey,
                          requesterOrigin: requester.origin,
                          operatorAuthority: admitted?.authority,
                          personalToolIdentityScoped: true,
                          personalToolSelection: Object.freeze({
                            operatorAuthority: admitted?.authority,
                            requesterOrigin: requester.origin,
                            assertCurrent,
                          }),
                          gatewayContextResolver: resolveGatewayContext,
                        },
                        run,
                      )
                    : run(),
              ),
            );
          } finally {
            admitted?.release();
          }
        },
      };
    } catch (error) {
      captured?.release();
      throw error;
    }
  });
}

/** Captured while live; its accepting owner, not the original invocation, releases it. */
export function captureOperatorToolGatewayContinuationContext(
  target?: { sessionKey: string; agentId?: string },
  options?: OperatorContinuationOptions,
) {
  return captureOperatorToolGatewayContinuationContextInternal(target, options);
}

/** Holds the original operator source until an accepted asynchronous follow-up settles. */
export async function runWithOperatorToolGatewayContinuationContext<T>(
  run: () => Promise<T>,
  agentId?: string,
): Promise<T> {
  const captured = await captureOperatorToolGatewayContinuationContext();
  if (!captured) {
    return await runWithOperatorToolGatewayCleanupContext(run);
  }
  try {
    return await captured.runWithRequester(run, agentId);
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
  const agentRuntimeIdentity = readInProcessAgentRuntimeIdentity(options);
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
  const service = resolvePluginSessionWorkDispatch({
    method,
    params,
    context,
    scopedPluginId: scope?.pluginId,
    pluginRuntimeOwnerId: options?.pluginRuntimeOwnerId,
  });
  const operatorRunAuthority =
    selection?.operatorAuthority ??
    caller?.operatorAuthority ??
    inheritedOperatorAuthority?.operatorRunAuthority ??
    scope?.client?.internal?.operatorRunAuthority;
  assertParticipationGatewayMethod(method, operatorRunAuthority);
  // A registered settle cohort owns its wake after the spawning tool has finished.
  // Qualify that live owner before replacing the tool lifetime at admission.
  const assertSettleWakeCurrent =
    method === "agent" ? options?.settleWakeReplay?.assertCurrent : undefined;
  const isHostOwnedAgentRun =
    method === "agent" && Boolean(options?.agentRunTracking || assertSettleWakeCurrent);
  const assertTransferredSettleWakeCurrent =
    assertSettleWakeCurrent && operatorRunAuthority ? assertSettleWakeCurrent : undefined;
  assertTransferredSettleWakeCurrent?.();
  const assertCallerCurrent = composePreparedOnlySessionSource(caller);
  const transfersCreatedInput =
    method === "sessions.create" &&
    (options?.sessionCreation?.via === "spawn" ||
      (options?.sessionCreation?.via === "operator" &&
        options.sessionCreation.requesterSessionKey === caller?.sessionKey &&
        options.sessionCreation.actor?.type === "human" &&
        options.sessionCreation.actor.source === "profile" &&
        options.sessionCreation.actor.id === operatorRunAuthority?.profileId)) &&
    caller?.operationalRunInstance !== undefined &&
    options.agentToolCaller?.agentId === caller.agentId &&
    options.agentToolCaller.sessionKey === caller.sessionKey;
  const assertInvocationCurrent = composeSessionSourceAssertion([
    // Host-owned agent paths may omit the ambient invocation guard below, but
    // none may outlive or broaden a recovered service operation's tool ceiling.
    service?.assertCurrent,
    selection?.assertCurrent,
    assertSettleWakeCurrent,
    !isHostOwnedAgentRun || !operatorRunAuthority
      ? composeSessionSourceAssertion(
          [inheritedOperatorAuthority?.assertCurrent],
          (assertSource) => {
            inheritedOperatorAuthority?.signal.throwIfAborted();
            assertSource();
          },
        )
      : undefined,
  ]);
  assertInvocationCurrent();
  if (!isHostOwnedAgentRun) {
    assertCallerCurrent?.();
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
  const scopedSystemScopes = resolveSystemScopeCeiling(method, options, scope?.client, caller);
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
  const syntheticScopes = resolveInProcessSyntheticScopes({
    method,
    params,
    operatorScopes,
    operatorAuthority: operatorRunAuthority,
    options,
    registeredScope: context.getGatewayMethodRegistry?.().getScope(method),
    allowOwnSessionScope: context.getGatewayMethodRegistry?.().getSessionAccess?.(method)
      ?.allowOwnSessionScope,
    clientScopes: scope?.client?.connect.scopes,
    agentRuntime: Boolean(agentRuntimeIdentity),
  });
  const hostApprovalRequestEligible =
    options?.allowHostPluginApprovalRequest === true &&
    isHostPluginApprovalMethod(method) &&
    options.forceSyntheticClient === true;
  const trustedPluginApprovalOwnerId =
    hostApprovalRequestEligible &&
    pluginRuntimeOwnerId &&
    pluginRuntimeOwnerId === scope?.pluginId?.trim() &&
    (scope.pluginOrigin === "bundled" ||
      scope.pluginTrustedOfficialInstall === true ||
      pluginRecord?.origin === "bundled" ||
      pluginRecord?.trustedOfficialInstall === true)
      ? pluginRuntimeOwnerId
      : undefined;
  const signedAgentApprovalOwnerId =
    hostApprovalRequestEligible &&
    agentRuntimeIdentity?.approvalOwnerPluginId?.trim() &&
    context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) === true
      ? agentRuntimeIdentity.approvalOwnerPluginId.trim()
      : undefined;
  const scopedOperatorCanRequest =
    scope?.client?.connect.role === "operator" &&
    roleScopesAllow({
      role: "operator",
      requestedScopes: [WRITE_SCOPE],
      allowedScopes: scope.client.connect.scopes ?? [],
    });
  const retainedOperatorCanRequest =
    !scope?.client &&
    signedAgentApprovalOwnerId !== undefined &&
    operatorRunAuthority !== undefined &&
    operatorRoleActor?.kind === "operator";
  if (retainedOperatorCanRequest) {
    assertAdmittedRunOperatorAuthority(operatorRunAuthority);
  }
  const hostApprovalRequestOwnerId =
    hostApprovalRequestEligible &&
    roleScopesAllow({
      role: "operator",
      requestedScopes: [WRITE_SCOPE],
      allowedScopes: operatorScopes ?? [],
    }) &&
    (scopedOperatorCanRequest || retainedOperatorCanRequest)
      ? scopedOperatorCanRequest
        ? (trustedPluginApprovalOwnerId ?? signedAgentApprovalOwnerId)
        : signedAgentApprovalOwnerId
      : undefined;
  // The host grants only request admission and the wait for that request's own verdict;
  // it never gives the plugin reviewer scopes.
  const requestScopes = hostApprovalRequestOwnerId ? [WRITE_SCOPE] : syntheticScopes;
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
    ...(hostApprovalRequestOwnerId
      ? { pluginApprovalRequestOwnerId: hostApprovalRequestOwnerId }
      : {}),
    ...(nodeInvokeApprovalSessionKey ? { nodeInvokeApprovalSessionKey } : {}),
    pluginSubagentRequester: options?.pluginSubagentRequester,
    runtimePluginToolGrant: options?.runtimePluginToolGrant,
    pluginSubagentToolsAllow: options?.pluginSubagentToolsAllow,
    delegatedToolPolicyHandoffId,
    ...(options?.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
    scopes: requestScopes,
  });
  const scopedStreamClient = options?.nodeInvokeStream ? scope?.client : undefined;
  const syntheticClient = projectPluginRuntimeClientExecution({
    client: baseSyntheticClient,
    streamClient: scopedStreamClient,
    identity: agentRuntimeIdentity,
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
  const assertGatewayCurrent = () => {
    if ((resolveGatewayContext ? resolveGatewayContext() : scope?.context) !== context) {
      throw new Error(
        `In-process gateway dispatch requires a current gateway instance binding (method: ${method}).`,
      );
    }
  };
  const assertSourceCurrent = assertGatewayCurrent;
  return {
    assertGatewayCurrent,
    assertSourceCurrent,
    assertInvocationCurrent,
    assertContextCurrent: composeSessionSourceAssertion([
      service?.assertCurrent,
      selection?.assertCurrent,
      assertSourceCurrent,
      method !== "agent" ? assertCallerCurrent : undefined,
      transfersCreatedInput ? options.agentToolCaller?.assertCurrent : undefined,
    ]),
    ...(transfersCreatedInput ? { assertCreatedInputSourceCurrent: assertSourceCurrent } : {}),
    client,
    context,
    delegatedToolPolicyHandoffId,
    isWebchatConnect,
    // A scoped plugin RPC may narrow its client during preparation. Bind the
    // source handler here while its exact pre-narrowing client is still known.
    parentHttpRequestAuthority:
      useScopedClient &&
      options?.disableSyntheticClient &&
      scope?.gatewayMethodDispatchAllowed &&
      !client.internal?.syntheticClient &&
      !client.internal?.authenticatedOperator
        ? scope.readRequestAuthority?.bind(undefined, scope.client)
        : undefined,
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
