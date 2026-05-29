import type { EmbeddedAgentQueueFailureReason } from "../../../agents/embedded-agent-runner/runs.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { VerboseLevel } from "../../thinking.js";
import type { ReplyPayload } from "../../types.js";
import type { QueueMode } from "./types.js";

export type BusyMessageOutcomeKind =
  | "active_run_steer_accepted"
  | "active_run_steer_rejected"
  | "followup_enqueued"
  | "collect_enqueued"
  | "interrupt_started"
  | "dropped";

export type BusyMessageOutcomeSource = "inbound" | "slash_steer" | "talk";

export type BusyMessageOutcomeRecord = {
  kind: BusyMessageOutcomeKind;
  sessionKey: string;
  sessionId: string;
  channel?: string;
  queueMode?: QueueMode;
  runtimeFamily?: string;
  reason?: EmbeddedAgentQueueFailureReason;
  recordedAtMs: number;
  source: BusyMessageOutcomeSource;
};

export const BUSY_MESSAGE_OUTCOME_LABELS: Record<BusyMessageOutcomeKind, string> = {
  active_run_steer_accepted: "Steered into active run",
  active_run_steer_rejected: "Active run rejected steering",
  followup_enqueued: "Queued as follow-up",
  collect_enqueued: "Queued for collect batch",
  interrupt_started: "Interrupting active run",
  dropped: "Dropped while busy",
};

const BUSY_MESSAGE_OUTCOMES_BY_SESSION_KEY = resolveGlobalMap<string, BusyMessageOutcomeRecord>(
  Symbol.for("openclaw.busyMessageOutcomesBySessionKey"),
);

const BUSY_MESSAGE_OUTCOMES_BY_SESSION_ID = resolveGlobalMap<string, BusyMessageOutcomeRecord>(
  Symbol.for("openclaw.busyMessageOutcomesBySessionId"),
);

export function formatBusyMessageOutcomeLabel(record: BusyMessageOutcomeRecord): string {
  const base = BUSY_MESSAGE_OUTCOME_LABELS[record.kind];
  if (record.kind === "active_run_steer_rejected" && record.reason) {
    return `${base} (${record.reason})`;
  }
  return base;
}

function formatBusyMessageOutcomeStatusDetail(record: BusyMessageOutcomeRecord): string {
  switch (record.kind) {
    case "active_run_steer_accepted":
      return "steered into active run";
    case "active_run_steer_rejected":
      return record.reason ? `steering rejected (${record.reason})` : "steering rejected";
    case "followup_enqueued":
      if (record.queueMode === "steer") {
        return record.reason
          ? `queued follow-up (steering unavailable: ${record.reason})`
          : "queued follow-up (steering unavailable)";
      }
      return "queued follow-up";
    case "collect_enqueued":
      return "queued for collect batch";
    case "interrupt_started":
      return "interrupting active run";
    case "dropped":
      return "dropped while busy";
  }
}

export function formatBusyMessageOutcomeStatusLine(sessionKeyOrId: string | undefined): string {
  const record = getLastBusyMessageOutcome(sessionKeyOrId);
  if (!record) {
    return "Last busy message: none.";
  }
  return `Last busy message: ${formatBusyMessageOutcomeStatusDetail(record)}.`;
}

export function isBusyMessageVerboseAckEnabled(verboseLevel: VerboseLevel | undefined): boolean {
  return verboseLevel === "on" || verboseLevel === "full";
}

function formatSteeringUnavailableReason(
  reason: EmbeddedAgentQueueFailureReason | undefined,
): string {
  return reason ?? "steering unavailable";
}

export function maybeBusyMessageVerboseAck(params: {
  kind: BusyMessageOutcomeKind;
  verboseLevel: VerboseLevel | undefined;
  reason?: EmbeddedAgentQueueFailureReason;
  steerRejectedFallback?: boolean;
}): ReplyPayload | undefined {
  if (!isBusyMessageVerboseAckEnabled(params.verboseLevel)) {
    return undefined;
  }
  if (params.kind === "active_run_steer_accepted") {
    return { text: "Steered current run." };
  }
  if (params.kind === "followup_enqueued" && params.steerRejectedFallback) {
    return {
      text: `Queued after current run: steering unavailable while ${formatSteeringUnavailableReason(params.reason)}.`,
    };
  }
  return undefined;
}

export type RecordBusyMessageOutcomeInput = {
  kind: BusyMessageOutcomeKind;
  sessionKey?: string;
  sessionId: string;
  channel?: string;
  queueMode?: QueueMode;
  runtimeFamily?: string;
  reason?: EmbeddedAgentQueueFailureReason;
  source?: BusyMessageOutcomeSource;
  recordedAtMs?: number;
};

export function recordBusyMessageOutcome(input: RecordBusyMessageOutcomeInput): void {
  const sessionId = normalizeOptionalString(input.sessionId);
  if (!sessionId) {
    return;
  }
  const sessionKey = normalizeOptionalString(input.sessionKey) ?? sessionId;
  const record: BusyMessageOutcomeRecord = {
    kind: input.kind,
    sessionKey,
    sessionId,
    recordedAtMs: input.recordedAtMs ?? Date.now(),
    source: input.source ?? "inbound",
    ...(normalizeOptionalString(input.channel) ? { channel: input.channel!.trim() } : {}),
    ...(input.queueMode ? { queueMode: input.queueMode } : {}),
    ...(normalizeOptionalString(input.runtimeFamily)
      ? { runtimeFamily: input.runtimeFamily!.trim() }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  BUSY_MESSAGE_OUTCOMES_BY_SESSION_KEY.set(sessionKey, record);
  BUSY_MESSAGE_OUTCOMES_BY_SESSION_ID.set(sessionId, record);
}

export function getLastBusyMessageOutcome(
  sessionKeyOrId: string | undefined,
): BusyMessageOutcomeRecord | undefined {
  const cleaned = normalizeOptionalString(sessionKeyOrId);
  if (!cleaned) {
    return undefined;
  }
  return (
    BUSY_MESSAGE_OUTCOMES_BY_SESSION_KEY.get(cleaned) ??
    BUSY_MESSAGE_OUTCOMES_BY_SESSION_ID.get(cleaned)
  );
}

export function clearBusyMessageOutcomeStoreForTest(): void {
  BUSY_MESSAGE_OUTCOMES_BY_SESSION_KEY.clear();
  BUSY_MESSAGE_OUTCOMES_BY_SESSION_ID.clear();
}
