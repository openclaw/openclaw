import { randomUUID } from "node:crypto";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../../agents/run-termination.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  isSubagentCoordinationInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { CommittedResetCompletion } from "../server-methods/agent-reset-phase.js";
import {
  buildBareSessionResetResponse,
  buildBareSessionResetResult,
  sessionResetAckText,
} from "../server-methods/agent-session-reset.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import {
  buildAbortedAgentPayload,
  isAcceptedAgentDedupePayload,
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setAbortedAgentDedupeEntries,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

export type AgentDedupeLifecycle = ReturnType<typeof createAgentDedupeLifecycle>;

export function createAgentDedupeLifecycle(params: {
  cfg: ReturnType<AgentTurnContext["getRuntimeConfig"]>;
  request: AgentRunRequest;
  runId: string;
  lifecycleGeneration: string;
  agentDedupeKeys: string[];
  suppressVisibleSessionEffects: boolean;
  inputProvenance?: InputProvenance;
  privateCompletion?: true;
  ownerConnId?: string;
  ownerDeviceId?: string;
  context: AgentTurnContext;
  io: AgentTurnIo;
}) {
  let reserved = false;
  let accepted = false;
  let committedResetCompletion: CommittedResetCompletion | undefined;
  const reservationId = randomUUID();

  const reserve = (sessionKey?: string, dedupeAgentId?: string) => {
    if (reserved) {
      return;
    }
    // A private retry bypasses terminal cache replay to reconcile durable input.
    // Preserve an exact intentional Stop for the resolved admission guard.
    if (
      isPreRegistrationAbortedAgentDedupeEntryForSession({
        entry: readGatewayDedupeEntry({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
        }),
        runId: params.runId,
        sessionKey,
        agentId: dedupeAgentId,
      })
    ) {
      return;
    }
    const acceptedAt = Date.now();
    const pendingTimeoutMs = resolveAgentTimeoutMs({
      cfg: params.cfg,
      overrideSeconds:
        typeof params.request.timeout === "number" ? params.request.timeout : undefined,
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      // Durable private input decides replay after the prior controller ends.
      // Its new reservation must retire stale sticky terminal projections.
      ...(params.privateCompletion && !params.context.chatAbortControllers.has(params.runId)
        ? { startNewAttempt: true as const }
        : {}),
      entry: {
        ts: acceptedAt,
        ok: true,
        payload: {
          runId: params.runId,
          reservationId,
          status: "accepted" as const,
          ...(sessionKey ? { sessionKey } : {}),
          ...(dedupeAgentId ? { agentId: dedupeAgentId } : {}),
          controlUiVisible:
            !params.suppressVisibleSessionEffects &&
            !isSubagentCoordinationInputProvenance(params.inputProvenance),
          acceptedAt,
          dedupeKeys: params.agentDedupeKeys,
          expiresAtMs: resolveAgentRunExpiresAtMs({ now: acceptedAt, timeoutMs: pendingTimeoutMs }),
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
        },
      },
    });
    reserved = true;
  };

  const recordCommittedReset = (completion: CommittedResetCompletion, followUpNotice: string) => {
    const responsePayload = buildBareSessionResetResponse({
      runId: params.runId,
      result: buildBareSessionResetResult({
        reason: completion.reason,
        sessionId: completion.sessionId,
        ackText: completion.followUpPending
          ? `${sessionResetAckText(completion.reason)} ${followUpNotice}`
          : undefined,
      }),
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      entry: { ts: Date.now(), ok: true, payload: responsePayload },
    });
    return responsePayload;
  };

  const clearUnaccepted = () => {
    if (!reserved || accepted) {
      return;
    }
    const entry = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    if (
      isPreRegistrationAbortedAgentDedupeEntryForSession({ entry, runId: params.runId }) ||
      (entry?.ok &&
        isAcceptedAgentDedupePayload(entry.payload) &&
        entry.payload.reservationId !== reservationId)
    ) {
      return;
    }
    if (committedResetCompletion) {
      // Cleanup may follow any failed follow-up admission, not only reset-phase
      // errors. Reconcile the reset fact without delivering or starting new work.
      if (!entry?.ok || !isAcceptedAgentDedupePayload(entry.payload)) {
        return;
      }
      recordCommittedReset(
        committedResetCompletion,
        "Request ended before the follow-up ran; send the follow-up message again.",
      );
      accepted = true;
      return;
    }
    for (const key of params.agentDedupeKeys) {
      params.context.dedupe.delete(key);
    }
    reserved = false;
  };

  const bindSessionTarget = (target: {
    sessionKey: string;
    agentId?: string;
    sessionId?: string;
  }) => {
    const entry = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    if (
      !entry?.ok ||
      !isAcceptedAgentDedupePayload(entry.payload) ||
      entry.payload.reservationId !== reservationId
    ) {
      return;
    }
    const previousKey =
      typeof entry.payload.sessionKey === "string" ? entry.payload.sessionKey : undefined;
    // Routing and the session COMMIT owner publish this attempt's target. Stop
    // never manufactures a pending-run incarnation from its own row lookup.
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys.filter(
        (key) => params.context.dedupe.get(key)?.payload === entry.payload,
      ),
      entry: {
        ...entry,
        payload: {
          ...entry.payload,
          ...target,
          ...(previousKey && previousKey !== target.sessionKey
            ? { sessionKeyAliases: [previousKey] }
            : {}),
        },
      },
    });
  };

  const abortForLifecycleRotation = (target?: { sessionKey?: string; agentId?: string }) => {
    if (params.lifecycleGeneration === getAgentEventLifecycleGeneration()) {
      return false;
    }
    if (committedResetCompletion) {
      const completion = committedResetCompletion;
      accepted = true;
      const responsePayload = recordCommittedReset(
        completion,
        "Gateway restarted before the follow-up ran; send the follow-up message again.",
      );
      params.io.emitAcceptance([true, responsePayload, undefined], { runId: params.runId });
      emitSessionsChanged(params.context, {
        sessionKey: completion.sessionKey,
        ...(completion.agentId ? { agentId: completion.agentId } : {}),
        reason: completion.reason,
      });
      return true;
    }
    accepted = true;
    setAbortedAgentDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      agentId: target?.agentId,
      sessionKey: target?.sessionKey,
      runId: params.runId,
      stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
    });
    params.io.emitAcceptance(
      [
        true,
        buildAbortedAgentPayload(params.runId, AGENT_RUN_RESTART_ABORT_STOP_REASON),
        undefined,
      ],
      { runId: params.runId },
    );
    return true;
  };

  return {
    reservationId,
    reserve,
    bindSessionTarget,
    clearUnaccepted,
    abortForLifecycleRotation,
    isReserved: () => reserved,
    isAccepted: () => accepted,
    markAccepted: (value: boolean) => {
      accepted = value;
    },
    setCommittedResetCompletion: (value: CommittedResetCompletion) => {
      committedResetCompletion = value;
    },
  };
}
