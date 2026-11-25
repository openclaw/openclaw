import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  isSubagentCoordinationInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import {
  getRpcSourceForGateway,
  hasUnretiredRpcSource,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { logAttachmentFailure } from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { CommittedResetCompletion } from "../server-methods/agent-reset-phase.js";
import {
  buildBareSessionResetResponse,
  buildBareSessionResetResult,
  sessionResetAckText,
} from "../server-methods/agent-session-reset.js";
import {
  AgentRequestReservationEndedError,
  isAcceptedAgentDedupePayload,
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  replayAgentTurnIfCached,
  setAbortedAgentDedupeEntries,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentTurnContext, AgentTurnFrame, AgentTurnIo } from "./types.js";

export type AgentDedupeLifecycle = ReturnType<typeof createAgentDedupeLifecycle>;

export function createAgentDedupeLifecycle(params: {
  cfg: ReturnType<AgentTurnContext["getRuntimeConfig"]>;
  request: AgentRunRequest;
  runId: string;
  agentDedupeKeys: string[];
  suppressVisibleSessionEffects: boolean;
  inputProvenance?: InputProvenance;
  reconcileDurableInput?: boolean;
  assertAdmissionCurrent?: () => void;
  assertCancellationCurrent?: () => void;
  ownerConnId?: string;
  ownerDeviceId?: string;
  context: AgentTurnContext;
  io: AgentTurnIo;
}) {
  let reserved = false;
  let accepted = false;
  let preservedStop: ReturnType<typeof readGatewayDedupeEntry>;
  let committedResetCompletion: CommittedResetCompletion | undefined;
  const reservationId = randomUUID();

  const reserve = (sessionKey?: string, dedupeAgentId?: string) => {
    if (reserved) {
      return;
    }
    // A durable retry bypasses terminal cache replay to reconcile its input.
    // Preserve an exact intentional Stop for the resolved admission guard.
    const previous = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    const previousIsIntentionalStop = isPreRegistrationAbortedAgentDedupeEntryForSession({
      entry: previous,
      runId: params.runId,
      sessionKey,
      agentId: dedupeAgentId,
    });
    const hasCurrentSource = () =>
      hasUnretiredRpcSource(
        params.runId,
        { sessionKey, agentId: dedupeAgentId },
        params.context.resolveGatewayContext,
      );
    const previousPayload = asOptionalRecord(previous?.payload);
    // A queued Stop remains final after its source retires. Executed input
    // reconciles through its durable completion instead of this transient cache.
    const stoppedBeforeExecution =
      previousPayload?.timeoutPhase === "queue" && previousPayload.providerStarted === false;
    if (
      previousIsIntentionalStop &&
      (!params.reconcileDurableInput || hasCurrentSource() || stoppedBeforeExecution)
    ) {
      preservedStop = previous;
      return;
    }
    const acceptedAt = Date.now();
    const pendingTimeoutMs = resolveAgentTimeoutMs({
      cfg: params.cfg,
      overrideSeconds: params.request.timeout,
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      // Durable input decides replay after the prior controller ends.
      // Its new reservation must retire stale sticky terminal projections.
      ...(params.reconcileDurableInput && !hasCurrentSource()
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

  const ownedReservationKeys = () =>
    !reserved || accepted
      ? []
      : params.agentDedupeKeys.filter((key) => {
          const entry = params.context.dedupe.get(key);
          return (
            entry?.ok &&
            isAcceptedAgentDedupePayload(entry.payload) &&
            entry.payload.reservationId === reservationId
          );
        });
  const ownsReservation = () => ownedReservationKeys().length === params.agentDedupeKeys.length;

  const assertReservationCurrent = () => {
    if (!ownsReservation()) {
      throw new AgentRequestReservationEndedError();
    }
  };

  const handlePreparationFailure =
    (assertCallerCurrent: (() => void) | undefined) =>
    (error: unknown): undefined => {
      assertCallerCurrent?.();
      // Preparation refusal must preserve the cached Stop or replacement response.
      if (
        !ownsReservation() &&
        replayAgentTurnIfCached({
          preflight: params,
          context: params.context,
          io: params.io,
          // A refused reservation may replay only the exact Stop preserved by
          // this target, never an unrelated or replaced terminal cache entry.
          acceptedOnly:
            params.reconcileDurableInput &&
            !(
              preservedStop &&
              readGatewayDedupeEntry({
                dedupe: params.context.dedupe,
                keys: params.agentDedupeKeys,
              }) === preservedStop
            ),
        })
      ) {
        return undefined;
      }
      if (error instanceof AgentRequestReservationEndedError) {
        logAttachmentFailure(params.context.logGateway, "agent attachment parse failed", error);
        params.io.emitAcceptance([
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, String(error)),
        ]);
        return undefined;
      }
      throw error;
    };

  const clearUnaccepted = () => {
    const keys = ownedReservationKeys();
    if (!keys.length) {
      return;
    }
    if (committedResetCompletion) {
      // Cleanup may follow any failed follow-up admission, not only reset-phase
      // errors. Reconcile the reset fact without delivering or starting new work.
      const completion = committedResetCompletion;
      const response: AgentTurnFrame = completion.replyError
        ? [false, undefined, completion.replyError]
        : [
            true,
            buildBareSessionResetResponse({
              runId: params.runId,
              result: buildBareSessionResetResult({
                reason: completion.reason,
                sessionId: completion.sessionId,
                ackText: completion.followUpPending
                  ? `${sessionResetAckText(completion.reason)} Request ended before the follow-up ran; send the follow-up message again.`
                  : undefined,
              }),
            }),
            undefined,
          ];
      setGatewayDedupeEntries({
        dedupe: params.context.dedupe,
        keys,
        entry: { ts: Date.now(), ok: response[0], payload: response[1], error: response[2] },
      });
      accepted = true;
      return;
    }
    for (const key of keys) {
      params.context.dedupe.delete(key);
    }
    reserved = false;
  };

  const cancelOwnedReservation = (target: {
    agentId?: string;
    sessionKey?: string;
    stopReason: string;
  }) => {
    if (accepted) {
      return false;
    }
    try {
      params.assertAdmissionCurrent?.();
    } catch {
      const source = getRpcSourceForGateway(params.runId, params.context.resolveGatewayContext);
      // A canceled execution owner may record its own cancellation, but cannot
      // replace an explicit Stop publisher or ignore independent authority loss.
      if (!params.assertCancellationCurrent || source?.adapter.projectSessionTerminalPending) {
        return false;
      }
      try {
        params.assertCancellationCurrent();
      } catch {
        return false;
      }
    }
    const keys = ownedReservationKeys();
    if (keys.length !== params.agentDedupeKeys.length) {
      return false;
    }
    setAbortedAgentDedupeEntries({
      dedupe: params.context.dedupe,
      keys,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      runId: params.runId,
      stopReason: target.stopReason,
    });
    accepted = true;
    return true;
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

  return {
    reservationId,
    ownsReservation,
    ownedReservationKeys,
    assertReservationCurrent,
    handlePreparationFailure,
    reserve,
    bindSessionTarget,
    clearUnaccepted,
    releaseUnacceptedReservation: () => {
      if (accepted || committedResetCompletion || !ownsReservation()) {
        return false;
      }
      clearUnaccepted();
      return !reserved;
    },
    cancelOwnedReservation,
    isReserved: () => reserved,
    markAccepted: (value: boolean) => {
      accepted = value;
    },
    setCommittedResetCompletion: (value: CommittedResetCompletion) => {
      committedResetCompletion = value;
    },
  };
}
