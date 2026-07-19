// Durable rolling transcript for the machine-wide OpenClaw conversation.
import { randomUUID } from "node:crypto";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";

export type SystemAgentTranscriptTurn = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

export const SYSTEM_AGENT_TRANSCRIPT_SCOPE = "system-agent-transcript";
export const SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES = 1_000;

function openTranscriptStore(env?: NodeJS.ProcessEnv) {
  return createSqliteAuditRecordStore<SystemAgentTranscriptTurn>({
    scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
    maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

/** Append one already-sanitized engine history turn to the rolling logbook. */
export function appendTranscriptTurn(
  turn: SystemAgentTranscriptTurn,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  openTranscriptStore(opts.env).register(`${turn.at}:${randomUUID()}`, turn, turn.at);
}

/** Read the newest window in conversational (oldest-first) order. */
export function readTranscriptTail(
  limit: number,
  opts: { env?: NodeJS.ProcessEnv } = {},
): SystemAgentTranscriptTurn[] {
  return openTranscriptStore(opts.env)
    .latest({ limit })
    .toReversed()
    .map((entry) => entry.value);
}
