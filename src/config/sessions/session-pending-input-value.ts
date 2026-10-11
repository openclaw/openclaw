import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { SessionPendingInputReceipt } from "./session-history-read.types.js";
import type { SessionPendingInput, SessionPendingInputRow } from "./session-pending-input.types.js";

export function parseSessionPendingInputMessage(messageJson: string): PersistedUserTurnMessage {
  const value: unknown = JSON.parse(messageJson);
  if (asOptionalRecord(value)?.role !== "user") {
    throw new Error("Pending input has an invalid persisted user message");
  }
  // SAFETY: only typed admission writes this JSON; parsing preserves its canonical message shape.
  return value as PersistedUserTurnMessage;
}

export function isFinalInputCompletion(outcome: AgentRunTerminalOutcome): boolean {
  return (
    outcome.reason === "completed" ||
    (outcome.reason === "cancelled" && outcome.stopReason !== "restart")
  );
}

export function projectSessionPendingInput(row: SessionPendingInputRow): SessionPendingInput {
  if (row.state !== "queued" && row.state !== "interrupted" && row.state !== "cancelled") {
    throw new Error("Pending input has an invalid disposition");
  }
  return {
    id: row.input_id,
    runId: row.run_id,
    message: parseSessionPendingInputMessage(row.message_json),
    acceptedAt: row.accepted_at,
    state: row.state,
  };
}

export function resolvePendingInputHistoryLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(20, Math.trunc(limit ?? 20)));
}

/** Select by stored byte sizes before either backend copies accepted message payloads. */
export function selectPendingInputHistoryPage(
  metadata: readonly { seq: number; serialized_bytes: number }[],
  limit: number,
): { selected: number[]; nextBefore: number | undefined } {
  const selected: number[] = [];
  let bytes = 0;
  for (const row of metadata) {
    if (selected.length === limit || bytes + row.serialized_bytes > MAX_PAYLOAD_BYTES) {
      break;
    }
    selected.push(row.seq);
    bytes += row.serialized_bytes;
  }
  if (metadata.length && !selected.length) {
    throw new Error("Stored pending input exceeds the Gateway payload limit");
  }
  return { selected, nextBefore: selected.length < metadata.length ? selected.at(-1) : undefined };
}

export function normalizePendingInputReceiptRunIds(runIds: readonly string[]): string[] {
  if (runIds.length > 50) {
    throw new Error("Pending input receipt lookup accepts at most 50 run IDs");
  }
  return [...new Set(runIds)];
}

export function projectPendingInputReceipts(
  rows: readonly Pick<SessionPendingInputRow, "run_id" | "consumed_event_id" | "state">[],
): SessionPendingInputReceipt[] {
  // A run ID is correlation, not unique authority. Ambiguous sources stay provisional.
  if (rows.length > 50 || new Set(rows.map((row) => row.run_id)).size !== rows.length) {
    throw new Error("Pending input receipt lookup has ambiguous source run IDs");
  }
  return rows.map((row) =>
    row.consumed_event_id == null
      ? row.state === "cancelled"
        ? { runId: row.run_id, state: "pending" as const, cancelled: true as const }
        : { runId: row.run_id, state: "pending" as const }
      : { runId: row.run_id, state: "consumed" as const, consumedByEventId: row.consumed_event_id },
  );
}
