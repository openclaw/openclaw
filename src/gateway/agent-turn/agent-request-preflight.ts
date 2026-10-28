import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../agents/agent-scope.js";
import { parseExecApprovalFollowupApprovalId } from "../../agents/bash-tools.exec-approval-followup-state.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import { normalizeSpawnedRunMetadata } from "../../agents/spawned-context.js";
import {
  findAuthorizedSwarmCollectorRequest,
  findSwarmCollectorSession,
} from "../../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentSessionFromEntry } from "../../agents/subagents/spawn/subagent-depth-policy.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import { validateStructuredOutputSchema } from "../../agents/subagents/swarm/swarm-output-schema.js";
import { getSwarmRunExecutionLane } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { CommandLaneConfiguration } from "../../process/lanes.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isExecCompletionInputProvenance,
  isMainSessionRestartRecoveryInputProvenance,
  isProgressCardRefreshInputProvenance,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import {
  createAgentDatabaseAdmissionErrorShape,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { waitForAgentDatabaseWriteAdmission } from "../../state/agent-database-preparation-context.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { resolveExpectedExistingSessionConstraint } from "../server-methods/agent-expected-session.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { withGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import { readGatewayDedupeEntry, resolveAgentDedupeKeys } from "./agent-dedupe.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

// Collector children are one-shot by contract; tell callers what to do instead of continuing one.
const COLLECTOR_CONTINUATION_REFUSAL =
  "Collector children (spawned with collect=true) are one-shot: they accept no steering or follow-up input, including after they finish or time out. Collect the result with agents_wait using the run id from the spawn receipt. To continue the work, start a new child with sessions_spawn that includes the context it needs: give it a larger runTimeoutSeconds if the previous child timed out, and omit collect if the work needs follow-up turns.";

export type AgentRequestPreflight = NonNullable<
  Awaited<ReturnType<typeof prepareAgentRequestPreflight>>
>;

/** Maximum fallback entries one agent.run request may carry. */
const MAX_REQUESTED_MODEL_FALLBACKS = 16;

/**
 * Normalizes a caller-supplied fallback ladder. Blank and duplicate entries are dropped so
 * the chain matches what the caller asked for.
 */
function normalizeRequestedModelFallbacks(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const fallbacks: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || fallbacks.includes(trimmed)) {
      continue;
    }
    fallbacks.push(trimmed);
  }
  return fallbacks.length > 0 ? fallbacks.slice(0, MAX_REQUESTED_MODEL_FALLBACKS) : undefined;
}

export async function prepareAgentRequestPreflight(params: {
  request: AgentRunRequest;
  context: AgentTurnContext;
  client: AgentTurnPrincipal | null;
  io: AgentTurnIo;
}) {
  const { request } = params;
  const rejectInvalidRequest = (message: string): undefined => {
    params.io.emitAcceptance([false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message)]);
    return undefined;
  };
  const cfg = params.context.getRuntimeConfig();
  const canUseInternalRuntimeHandoff =
    params.client?.connect?.client?.mode === GATEWAY_CLIENT_MODES.BACKEND;
  const requestSessionKey = request.sessionKey?.trim();
  const parsedRequestSessionKey = requestSessionKey
    ? parseAgentSessionKey(requestSessionKey)
    : undefined;
  const preparingAgentId =
    parsedRequestSessionKey?.agentId ??
    normalizeOptionalString(request.agentId) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, requestSessionKey);
  if (preparingAgentId) {
    await waitForAgentDatabaseWriteAdmission(preparingAgentId, {
      owner: params.context.resolveGatewayContext?.()?.agentDatabaseStartup,
    });
  }
  const bareSessionAgent =
    requestSessionKey && !parsedRequestSessionKey
      ? resolveRequestedSessionAgentId(cfg, requestSessionKey, request.agentId)
      : undefined;
  if (bareSessionAgent && !bareSessionAgent.ok) {
    params.io.emitAcceptance([false, undefined, bareSessionAgent.error]);
    return undefined;
  }
  const selectedAgentId =
    parsedRequestSessionKey?.agentId ??
    bareSessionAgent?.agentId ??
    normalizeOptionalString(request.agentId) ??
    tryResolveLegacyCompatibilityAgentId(cfg);
  const refusal = selectedAgentId ? readAgentDatabaseAdmissionRefusal(selectedAgentId) : undefined;
  if (refusal) {
    params.io.emitAcceptance([false, undefined, createAgentDatabaseAdmissionErrorShape(refusal)]);
    return undefined;
  }
  const collectorSession = findSwarmCollectorSession(requestSessionKey, selectedAgentId);
  let swarmExecutionLane: CommandLaneConfiguration | undefined;
  // Collector children always use subagent session keys, so ordinary traffic
  // must never pay the persisted-store read. The store fallback only covers a
  // freshly restarted gateway whose in-memory registry has not reloaded yet.
  const persistedCollectorSession =
    !collectorSession && requestSessionKey && isSubagentSessionKey(requestSessionKey)
      ? (
          await readSessionEntryReadOnlyInWorker({
            ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
            storePath: resolveSessionStorePathCore(cfg.session?.store, {
              agentId: selectedAgentId,
            }),
            sessionKey: requestSessionKey,
          })
        )?.swarmCollector === true
      : false;
  if (
    collectorSession ||
    persistedCollectorSession ||
    request.swarmCollector === true ||
    request.swarmOutputSchema !== undefined
  ) {
    const schemaError = request.swarmOutputSchema
      ? validateStructuredOutputSchema(request.swarmOutputSchema)
      : undefined;
    if (request.swarmCollector !== true || schemaError) {
      return rejectInvalidRequest(
        schemaError ??
          (collectorSession || persistedCollectorSession
            ? COLLECTOR_CONTINUATION_REFUSAL
            : "swarm collector output schemas require swarmCollector=true"),
      );
    }
    const registeredCollector = findAuthorizedSwarmCollectorRequest({
      childSessionKey: request.sessionKey,
      childAgentId: selectedAgentId,
      idempotencyKey: request.idempotencyKey,
      outputSchema: request.swarmOutputSchema,
    });
    const collectorDedupe = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: resolveAgentDedupeKeys({ idempotencyKey: request.idempotencyKey }),
    });
    const swarmRequesterSessionKey =
      registeredCollector?.swarmRequesterSessionKey ?? registeredCollector?.requesterSessionKey;
    const swarmEnabled = resolveSwarmConfig(
      cfg,
      registeredCollector?.requesterAgentId ??
        (swarmRequesterSessionKey
          ? (parseAgentSessionKey(swarmRequesterSessionKey)?.agentId ?? selectedAgentId)
          : selectedAgentId),
    ).enabled;
    const pendingCollectorLaunch =
      registeredCollector?.swarmLaunchPending === true &&
      !registeredCollector.collectorCompletion &&
      typeof registeredCollector.execution.endedAt !== "number";
    if (
      (!swarmEnabled && !collectorDedupe) ||
      !canUseInternalRuntimeHandoff ||
      request.lane !== "subagent" ||
      !registeredCollector ||
      (!pendingCollectorLaunch && !collectorDedupe)
    ) {
      return rejectInvalidRequest(
        "swarm collector fields require an enabled, host-registered collector run",
      );
    }
    swarmExecutionLane = getSwarmRunExecutionLane(
      registeredCollector.schedulerSlotId ?? registeredCollector.runId,
    );
  }
  if (request.cwd && !path.isAbsolute(request.cwd)) {
    return rejectInvalidRequest("cwd must be absolute");
  }
  if (request.cwd && !normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId)) {
    return rejectInvalidRequest("cwd is reserved for plugin-owned subagent runs");
  }
  const allowModelOverride =
    hasGatewayAdminScope(params.client) || params.client?.internal?.allowModelOverride === true;
  const canUseCronRunContinuation = params.client?.internal?.cronRunContinuation === true;
  const expectedSessionResult = resolveExpectedExistingSessionConstraint({
    canUseInternalRuntimeHandoff,
    expectedExistingSessionId: request.expectedExistingSessionId,
    expectedExistingSessionLifecycleRevision: request.expectedExistingSessionLifecycleRevision,
    internalRuntimeHandoffId: request.internalRuntimeHandoffId,
  });
  if (!expectedSessionResult.ok) {
    return rejectInvalidRequest(expectedSessionResult.error);
  }
  const requestedPromptPersistenceSuppression = request.suppressPromptPersistence === true;
  const requestedInternalSessionEffects = request.sessionEffects === "internal";
  const requestedModelOverride = Boolean(request.provider || request.model);
  const requestedModelFallbacks = normalizeRequestedModelFallbacks(request.fallbacks);
  const isOneShotModelRun = request.modelRun === true;
  const isRawModelRun = isOneShotModelRun || request.promptMode === "none";
  if (request.promptMode === "none" && !isOneShotModelRun) {
    return rejectInvalidRequest(
      'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
    );
  }
  if (requestedModelOverride && !allowModelOverride) {
    return rejectInvalidRequest("provider/model overrides are not authorized for this caller.");
  }
  if (requestedModelFallbacks && !allowModelOverride) {
    return rejectInvalidRequest("model fallback overrides are not authorized for this caller.");
  }
  if (
    (requestedInternalSessionEffects || requestedPromptPersistenceSuppression) &&
    !canUseInternalRuntimeHandoff
  ) {
    return rejectInvalidRequest(
      "internal session-effect controls are reserved for backend callers.",
    );
  }
  const runId = request.idempotencyKey;
  const execApprovalFollowupApprovalId = parseExecApprovalFollowupApprovalId(runId);
  if (execApprovalFollowupApprovalId && !canUseInternalRuntimeHandoff) {
    return rejectInvalidRequest(
      "exec approval followup idempotency keys are reserved for backend callers.",
    );
  }
  const inputProvenance = normalizeInputProvenance(request.inputProvenance);
  if (isProgressCardRefreshInputProvenance(inputProvenance) && !canUseInternalRuntimeHandoff) {
    return rejectInvalidRequest("Progress refresh input is reserved for progressCard.refresh.");
  }
  // Plugin tools read the starting run named on exec completion wakes; only the host stamps it.
  if (isExecCompletionInputProvenance(inputProvenance) && !canUseInternalRuntimeHandoff) {
    return rejectInvalidRequest("Exec completion input is reserved for background exec owners.");
  }
  if (inputProvenance?.kind === "inter_session" && inputProvenance.sourceTool === "sessions_send") {
    const sourceSessionKey = inputProvenance.sourceSessionKey;
    const sourceAgentId = parseAgentSessionKey(sourceSessionKey)?.agentId;
    const sourceTarget =
      sourceSessionKey && sourceAgentId
        ? await withGatewaySessionStoreTarget(
            { cfg, key: sourceSessionKey, agentId: sourceAgentId, projection: "full" },
            (target) => target,
          )
        : undefined;
    const sourceEntry = sourceTarget ? sourceTarget.store[sourceTarget.canonicalKey] : undefined;
    let sourceIsSubagent = Boolean(
      sourceTarget && isSubagentSessionFromEntry(sourceTarget.canonicalKey, sourceEntry),
    );
    if (
      !sourceIsSubagent &&
      sourceTarget &&
      sourceEntry &&
      (sourceEntry.parentSessionKey || sourceEntry.spawnedBy)
    ) {
      const [sourceAcp] = await readAcpSessionMetaForEntries({
        entries: [
          {
            sessionKey: sourceTarget.canonicalKey,
            agentId: sourceTarget.agentId,
            entry: sourceEntry,
          },
        ],
        cfg,
      });
      sourceIsSubagent = isSubagentSessionFromEntry(
        sourceTarget.canonicalKey,
        sourceEntry,
        sourceAcp,
      );
    }
    if (sourceIsSubagent) {
      inputProvenance.sourceRole = "subagent";
    } else {
      delete inputProvenance.sourceRole;
    }
  }
  const isRestartRecoveryResumeRun =
    canUseInternalRuntimeHandoff && isMainSessionRestartRecoveryInputProvenance(inputProvenance);
  if (
    (request.internalExecutionIdentityRetry !== undefined ||
      request.internalExecutionIdentityRecoveryAttempt !== undefined) &&
    !isRestartRecoveryResumeRun
  ) {
    return rejectInvalidRequest(
      "internal execution identity recovery fields are reserved for main-session restart recovery.",
    );
  }
  // Child recovery shares the restricted tool policy, but not main-session cycle ownership.
  const canUseRestartRecoveryToolPolicy =
    isRestartRecoveryResumeRun ||
    (canUseInternalRuntimeHandoff &&
      inputProvenance?.kind === "internal_system" &&
      inputProvenance.sourceTool === "subagent_restart_recovery" &&
      requestSessionKey !== undefined &&
      inputProvenance.sourceSessionKey === requestSessionKey);
  if (request.forceCodeModeTools === true && !canUseRestartRecoveryToolPolicy) {
    return rejectInvalidRequest("forceCodeModeTools is reserved for native restart recovery.");
  }
  const sessionEffects =
    isOneShotModelRun || requestedInternalSessionEffects ? "internal" : request.sessionEffects;
  const agentDedupeKeys = resolveAgentDedupeKeys({
    idempotencyKey: runId,
    execApprovalFollowupApprovalId,
  });
  // The public legacy wire tag retains noninteractive bootstrap behavior.
  const bootstrapContextRunKind: BootstrapContextRunKind | undefined =
    request.bootstrapContextRunKind === "heartbeat" ? "cron" : request.bootstrapContextRunKind;
  return {
    request,
    bootstrapContextRunKind,
    cfg,
    runId,
    allowModelOverride,
    canUseInternalRuntimeHandoff,
    canUseCronRunContinuation,
    expectedSession: expectedSessionResult.constraint,
    expectedExistingSessionId: expectedSessionResult.constraint?.sessionId,
    providerOverride: allowModelOverride ? request.provider : undefined,
    modelOverride: allowModelOverride ? request.model : undefined,
    modelFallbacksOverride: allowModelOverride ? requestedModelFallbacks : undefined,
    modelFallbacksOverrideSource:
      allowModelOverride && requestedModelFallbacks ? ("request" as const) : undefined,
    execApprovalFollowupApprovalId,
    normalizedSpawned: normalizeSpawnedRunMetadata({
      groupId: request.groupId,
      groupChannel: request.groupChannel,
      groupSpace: request.groupSpace,
    }),
    inputProvenance,
    isRestartRecoveryResumeRun,
    preserveUserFacingSessionModelState:
      canUseInternalRuntimeHandoff &&
      shouldPreserveUserFacingSessionStateForInputProvenance(inputProvenance),
    sessionEffects,
    suppressVisibleSessionEffects: sessionEffects === "internal",
    requestedPromptPersistenceSuppression,
    isOneShotModelRun,
    isRawModelRun,
    agentDedupeKeys,
    swarmExecutionLane,
  };
}
