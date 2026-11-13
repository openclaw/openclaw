import {
  createCronCreatorAuthorityCapability,
  isPersonalReminderDelegation,
  type CronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { requesterCreatorProfileId } from "../../agents/requester-origin.js";
import {
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import type { CronScheduledToolCallerOrigin } from "../../cron/scheduled-tool-policy.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { revokeCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import { CRON_SCOPE, hasGatewayAdminScope } from "../operator-scopes.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayCronCreatorAuthorityAdmission = Readonly<{
  runId: string;
  callerOrigin: CronScheduledToolCallerOrigin;
  managementEntitlement?: CronCreatorAuthorityCapability["managementEntitlement"];
  requesterOwner?: CronCreatorAuthorityCapability["requesterOwner"];
  /** Fresh remote user input may create under its existing caller restrictions. */
  callerScopedCreation?: true;
  personalReminder?: CronCreatorAuthorityCapability["personalReminder"];
  isCurrent?: () => boolean;
  bindRunScope?: (scope: CronCreatorAuthorityCapability) => void;
  /** Exact requester scope already bound before Gateway acceptance. */
  boundRunScope?: CronCreatorAuthorityCapability;
  /** Retires accepted continuation custody even when dispatch never starts. */
  release?: () => void;
}>;

type DirectOperatorAuthorityParams = {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  isCurrent?: () => boolean;
  inputProvenance?: InputProvenance;
  disallowed: boolean;
};

/** Classifies a direct operator connection without granting any capability. */
export function isDirectGatewayUserClient(client: GatewayClient | null | undefined): boolean {
  const internal = client?.internal;
  return (
    client != null &&
    internal?.syntheticClient !== true &&
    internal?.senderAttribution === undefined &&
    internal?.approvalRuntime !== true &&
    internal?.cronRunContinuation !== true &&
    internal?.agentRuntimeIdentity === undefined &&
    internal?.pluginRuntimeOwnerId === undefined &&
    internal?.agentRunTracking === undefined &&
    internal?.pluginSubagentRequester === undefined &&
    internal?.runtimePluginToolGrant === undefined &&
    internal?.delegatedToolPolicyHandoffId === undefined
  );
}

function isDirectGatewayUserTurn(params: DirectOperatorAuthorityParams): boolean {
  return (
    params.runId.trim().length > 0 &&
    isDirectGatewayUserClient(params.client) &&
    Boolean(params.resolvedSessionKey?.trim()) &&
    !params.spawnedBy?.trim() &&
    params.inputProvenance === undefined &&
    !params.disallowed
  );
}

function resolveDirectOperatorAuthority(
  params: DirectOperatorAuthorityParams,
): GatewayCronCreatorAuthorityAdmission | undefined {
  const internal = params.client?.internal;
  const runId = params.runId.trim();
  const isDirectTurn = isDirectGatewayUserTurn(params);
  if (isDirectTurn && params.resolvedSessionKey) {
    // A new user admission replaces pending task authority, including for a non-admin caller.
    revokeRequesterCronAuthority(params.resolvedSessionKey);
  }
  const isDirectOperator =
    isDirectTurn &&
    hasGatewayAdminScope(params.client) &&
    (internal?.isLocalClient === true || internal?.controlUiAdmin === true);
  const isScopedOperator =
    isDirectTurn && operatorScopeSatisfied(CRON_SCOPE, params.client?.connect.scopes ?? []);
  return isDirectOperator || isScopedOperator
    ? Object.freeze({
        runId,
        // Remote management admission does not confer the direct-local creator/operator capability.
        callerOrigin:
          isDirectOperator && internal?.isLocalClient === true
            ? { kind: "local" as const }
            : { kind: "unknown" as const },
        ...(isDirectOperator && internal?.controlUiAdmin === true
          ? { managementEntitlement: { source: "control-ui-admin" as const } }
          : {}),
        ...(!isDirectOperator || internal?.isLocalClient !== true
          ? { callerScopedCreation: true as const }
          : {}),
        ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
      })
    : undefined;
}

/** Admits scoped scheduling separately from local-owner and Control UI admin management. */
export function resolveGatewayCronCreatorAuthorityAdmission(params: {
  runId: string;
  resolvedSessionKey?: string;
  sessionId?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  isCurrent?: () => boolean;
  request: AgentRunRequest;
  inputProvenance?: InputProvenance;
  hasRestoredCronContinuation: boolean;
  isOneShotModelRun: boolean;
}): GatewayCronCreatorAuthorityAdmission | undefined {
  const request = params.request;
  const caller = params.client?.internal?.agentToolCaller;
  const delegated = caller?.personalReminder;
  if (
    params.client?.internal?.syntheticClient === true &&
    params.client.internal.agentRunTracking === "native_subagent" &&
    request.lane === "subagent" &&
    !params.hasRestoredCronContinuation &&
    !params.isOneShotModelRun &&
    isPersonalReminderDelegation(delegated) &&
    caller?.requesterOrigin?.sessionKey === delegated.origin.sessionKey &&
    requesterCreatorProfileId(caller.requesterOrigin) === delegated.origin.profileId &&
    delegated.isCurrent()
  ) {
    // Admission transfers an independently retained human source; the parent
    // run's ordinary settlement must not retire the accepted child's authority.
    const childSource = delegated.claim();
    if (!childSource) {
      return undefined;
    }
    return Object.freeze({
      runId: params.runId,
      callerOrigin: { kind: "external" as const, channel: "telegram" },
      callerScopedCreation: true as const,
      personalReminder: delegated.origin,
      isCurrent: childSource.isCurrent,
      release: childSource.release,
    });
  }
  if (
    params.client?.internal?.syntheticClient === true &&
    !params.hasRestoredCronContinuation &&
    !params.isOneShotModelRun
  ) {
    const continuation = consumeRequesterCronAuthorityAdmission({
      runId: params.runId,
      sessionKey: params.resolvedSessionKey,
      sessionId: params.sessionId,
      inputProvenance: params.inputProvenance,
    });
    if (continuation) {
      return continuation;
    }
  }
  return resolveDirectOperatorAuthority({
    ...params,
    disallowed:
      params.hasRestoredCronContinuation ||
      params.isOneShotModelRun ||
      request.modelRun === true ||
      request.acpTurnSource !== undefined ||
      request.internalRuntimeHandoffId !== undefined ||
      request.execApprovalFollowupExpectedSessionId !== undefined ||
      request.internalEvents !== undefined ||
      request.sessionEffects === "internal" ||
      request.suppressPromptPersistence === true ||
      request.swarmCollector === true ||
      request.lane === "subagent",
  });
}

/** Owns requester run-scope transfer before acceptance and through undispatched cleanup. */
export function prepareGatewayCronCreatorAuthorityAdmission(
  params: Parameters<typeof resolveGatewayCronCreatorAuthorityAdmission>[0],
  signal: AbortSignal,
): GatewayCronCreatorAuthorityAdmission | undefined {
  const authority = resolveGatewayCronCreatorAuthorityAdmission(params);
  if (!authority?.bindRunScope) {
    // Direct human/operator admissions retain dispatch-time scope issuance.
    return authority;
  }
  let boundRunScope: CronCreatorAuthorityCapability | undefined;
  let released = false;
  const revokeBoundRunScope = () => {
    if (boundRunScope) {
      revokeCronCreatorAuthorityRunScope(boundRunScope);
    }
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    signal.removeEventListener("abort", revokeBoundRunScope);
    try {
      revokeBoundRunScope();
    } finally {
      authority.release?.();
    }
  };
  try {
    boundRunScope = createCronCreatorAuthorityCapability(
      authority.runId,
      authority.callerOrigin,
      authority.managementEntitlement,
      authority.isCurrent,
      undefined,
      authority.requesterOwner,
      authority.callerScopedCreation,
      authority.personalReminder,
    );
    if (!boundRunScope) {
      throw new Error("Requester continuation run scope could not be created");
    }
    signal.addEventListener("abort", revokeBoundRunScope, { once: true });
    signal.throwIfAborted();
    authority.bindRunScope(boundRunScope);
    return { ...authority, boundRunScope, release };
  } catch (error) {
    release();
    throw error;
  }
}

type GatewayChatUserTurn = {
  runId: string;
  resolvedSessionKey?: string;
  spawnedBy?: string;
  client?: GatewayClient | null;
  isCurrent?: () => boolean;
  inputProvenance?: InputProvenance;
  hasExplicitOrigin: boolean;
  hasRestoredCronContinuation: boolean;
  isIncognito: boolean;
  isReconnectResume: boolean;
  isSystemGenerated: boolean;
  turnKind: "btw" | "main";
  isDirectExternalUser: boolean;
};

/** Current external user input, independently of the permission being admitted. */
export function isDirectGatewayChatUserTurn(params: GatewayChatUserTurn): boolean {
  return isDirectGatewayUserTurn({
    ...params,
    disallowed:
      !params.isDirectExternalUser ||
      params.hasExplicitOrigin ||
      params.hasRestoredCronContinuation ||
      params.isSystemGenerated ||
      params.turnKind !== "main",
  });
}

/** Mints the same authority for an admitted ordinary operator chat.send turn. */
export function resolveGatewayChatCronCreatorAuthorityAdmission(
  params: GatewayChatUserTurn,
): GatewayCronCreatorAuthorityAdmission | undefined {
  return resolveDirectOperatorAuthority({
    ...params,
    disallowed:
      params.isIncognito || params.isReconnectResume || !isDirectGatewayChatUserTurn(params),
  });
}
