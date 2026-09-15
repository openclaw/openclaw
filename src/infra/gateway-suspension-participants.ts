// Optional registry letting plugins fence background work the Gateway cannot see.
//
// Core accounting only covers work that flows through Gateway-owned queues,
// sessions, and runs. A plugin that owns its own background queue registers a
// participant here so its work is closed and counted inside the same atomic
// suspension fence.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Active work a participant still owns. Zero means the participant is idle. */
type GatewaySuspensionParticipantReport = {
  activeCount: number;
  /** Operator-facing blocker text. Defaults to a generic count message. */
  message?: string;
};

export type GatewaySuspensionParticipant = {
  id: string;
  /**
   * Close the participant's own admission and report work still in flight.
   * Synchronous by contract: the core fence must not yield between closing
   * admission and taking the authoritative snapshot, or new work could slip in.
   */
  prepare: () => GatewaySuspensionParticipantReport;
  /** Report current work without changing admission state. */
  status: () => GatewaySuspensionParticipantReport;
  /** Reopen the participant's admission on resume, rollback, or lease expiry. */
  resume: () => void | Promise<void>;
};

export type GatewaySuspensionParticipantBlocker = {
  participantId: string;
  count: number;
  message: string;
};

type GatewaySuspensionParticipantState = {
  // Keyed by instance, not id: unregister or a plugin reload can drop or replace
  // the registry entry while a lease is held, and only the exact instance whose
  // prepare() closed the queue can reopen it. Losing it strands that queue closed
  // after the Gateway reports the suspension recovered.
  prepared: Map<
    GatewaySuspensionParticipant,
    {
      failure?: GatewaySuspensionParticipantBlocker;
      resuming?: Promise<void>;
    }
  >;
  pluginParticipants: readonly GatewaySuspensionParticipant[];
};

const PARTICIPANT_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspensionParticipantState"),
  (): GatewaySuspensionParticipantState => ({
    prepared: new Map(),
    pluginParticipants: [],
  }),
);

/** Stand-in count for a participant that cannot be trusted to be idle. */
const UNUSABLE_REPORT_COUNT = 1;

function unusableReportBlocker(
  participantId: string,
  reason: string,
): GatewaySuspensionParticipantBlocker {
  return {
    participantId,
    count: UNUSABLE_REPORT_COUNT,
    message: `${participantId} ${reason}`,
  };
}

/**
 * Convert a participant's raw return value into a blocker.
 *
 * Fails closed: only an exact synchronous non-negative integer may report idle.
 * A promise, missing field, NaN, or any other shape means the participant did
 * not actually fence and account for its queue, so it blocks the suspension
 * instead of silently permitting an unsafe host freeze.
 */
function toBlocker(
  participantId: string,
  report: unknown,
): GatewaySuspensionParticipantBlocker | null {
  if (!isRecord(report)) {
    throw new Error("returned an unusable suspension report");
  }
  if (typeof report.then === "function") {
    // Consume rejected async reports without treating them as successful fencing.
    void Promise.resolve(report).catch(() => {});
    throw new Error("returned an asynchronous suspension report");
  }
  const activeCount = report.activeCount;
  if (typeof activeCount !== "number" || !Number.isSafeInteger(activeCount) || activeCount < 0) {
    throw new Error("reported an invalid active count");
  }
  if (activeCount === 0) {
    return null;
  }
  const message = report.message;
  const trimmed = typeof message === "string" ? message.trim() : "";
  return {
    participantId,
    count: activeCount,
    message: trimmed || `${activeCount} active ${participantId} operation(s)`,
  };
}

function assertRegistrationAllowed(): void {
  if (isGatewayWorkAdmissionClosed() || PARTICIPANT_STATE.prepared.size > 0) {
    throw new Error("gateway suspension participants cannot register while admission is closed");
  }
}

/** Publish only contributions owned by the active plugin registry. */
export function setGatewayPluginSuspensionParticipants(
  participants: readonly GatewaySuspensionParticipant[],
): void {
  if (
    participants.some((participant) => !PARTICIPANT_STATE.pluginParticipants.includes(participant))
  ) {
    assertRegistrationAllowed();
  }
  PARTICIPANT_STATE.pluginParticipants = [...participants];
}

/** Point-in-time work includes detached queues still owned by the held lease. */
export function inspectGatewaySuspensionParticipants(): GatewaySuspensionParticipantBlocker[] {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  const participants = new Set([
    ...PARTICIPANT_STATE.pluginParticipants,
    ...PARTICIPANT_STATE.prepared.keys(),
  ]);
  for (const participant of participants) {
    const failure = PARTICIPANT_STATE.prepared.get(participant)?.failure;
    if (failure) {
      blockers.push(failure);
      continue;
    }
    try {
      const blocker = toBlocker(participant.id, participant.status());
      if (blocker) {
        blockers.push(blocker);
      }
    } catch {
      blockers.push(unusableReportBlocker(participant.id, "suspension status unavailable"));
    }
  }
  return blockers;
}

/** Close queues synchronously and retain failed fencing until recovery. */
export function prepareGatewaySuspensionParticipants(): GatewaySuspensionParticipantBlocker[] {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  for (const participant of PARTICIPANT_STATE.pluginParticipants) {
    // A failed callback may still close its queue and therefore owes recovery.
    const preparation: { failure?: GatewaySuspensionParticipantBlocker } = {};
    PARTICIPANT_STATE.prepared.set(participant, preparation);
    try {
      const blocker = toBlocker(participant.id, participant.prepare());
      if (blocker) {
        blockers.push(blocker);
      }
    } catch {
      preparation.failure = unusableReportBlocker(
        participant.id,
        "could not prepare for suspension",
      );
      blockers.push(preparation.failure);
    }
  }
  return blockers;
}

/**
 * Reopen every prepared participant, including ones unregistered or replaced
 * while the lease was held. Throws when any participant fails so the
 * coordinator's existing fail-closed scheduler recovery owns the retry, rather
 * than reopening core admission over a still-fenced participant.
 */
export function resumeGatewaySuspensionParticipants(): void;
export function resumeGatewaySuspensionParticipants(options: { wait: true }): void | Promise<void>;
export function resumeGatewaySuspensionParticipants(options?: {
  wait: true;
}): void | Promise<void> {
  const failed: string[] = [];
  for (const [participant, preparation] of PARTICIPANT_STATE.prepared) {
    if (preparation.resuming) {
      failed.push(participant.id);
      continue;
    }
    try {
      const result = participant.resume();
      if (result) {
        preparation.resuming = Promise.resolve(result).then(
          () => {
            if (PARTICIPANT_STATE.prepared.get(participant) === preparation) {
              PARTICIPANT_STATE.prepared.delete(participant);
            }
          },
          (error: unknown) => {
            preparation.resuming = undefined;
            throw error;
          },
        );
        // Normal RPC recovery is synchronous; its retry timer observes settlement.
        // Attach a rejection handler even when no lifecycle caller awaits this promise.
        void preparation.resuming.catch(() => {});
        failed.push(participant.id);
      } else {
        PARTICIPANT_STATE.prepared.delete(participant);
      }
    } catch {
      failed.push(participant.id);
    }
  }
  if (failed.length > 0) {
    if (options?.wait) {
      const pending = [...PARTICIPANT_STATE.prepared.values()].map((entry) => entry.resuming);
      if (pending.every((promise) => promise !== undefined)) {
        return Promise.all(pending).then(() => {});
      }
    }
    throw new Error(`gateway suspension participants failed to resume: ${failed.join(", ")}`);
  }
}
