// Durable rolling transcript for the machine-wide OpenClaw conversation.
import { randomUUID } from "node:crypto";
import {
  createSqliteAuditRecordReader,
  registerSqliteAuditRecordAsync,
} from "../infra/sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";

type SystemAgentTranscriptEntry = {
  role: "user" | "assistant" | "reset";
  text: string;
  at: number;
};

type SystemAgentTranscriptTurn = Omit<SystemAgentTranscriptEntry, "role"> & {
  role: "user" | "assistant";
};

const SYSTEM_AGENT_TRANSCRIPT_SCOPE = "system-agent-transcript";
const SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES = 1_000;

function openTranscriptStore(env?: NodeJS.ProcessEnv) {
  return createSqliteAuditRecordStore<SystemAgentTranscriptEntry>({
    scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
    maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

/** Append one already-sanitized engine history turn to the rolling logbook. */
export function appendTranscriptTurn(
  turn: SystemAgentTranscriptEntry,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  openTranscriptStore(opts.env).register(`${turn.at}:${randomUUID()}`, turn, turn.at);
}

export async function appendTranscriptTurnAsync(
  turn: SystemAgentTranscriptEntry,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await registerSqliteAuditRecordAsync(
    {
      scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
      maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
      env: opts.env,
    },
    { key: `${turn.at}:${randomUUID()}`, value: turn, createdAt: turn.at },
  );
}

/** Mark a durable context boundary without deleting earlier logbook rows. */
export function appendTranscriptReset(opts: { env?: NodeJS.ProcessEnv } = {}): void {
  appendTranscriptTurn({ role: "reset", text: "", at: Date.now() }, opts);
}

/**
 * Read the newest window in conversational (oldest-first) order. Markers are
 * never exposed; seeding may additionally start after the newest marker.
 */
export function readTranscriptTail(
  limit: number,
  opts: { afterLastReset?: boolean; env?: NodeJS.ProcessEnv } = {},
): SystemAgentTranscriptTurn[] {
  const entries = openTranscriptStore(opts.env)
    .latest({ limit })
    .toReversed()
    .map((entry) => entry.value);
  return transcriptTail(entries, opts.afterLastReset);
}

export async function readTranscriptTailAsync(
  limit: number,
  opts: { afterLastReset?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<SystemAgentTranscriptTurn[]> {
  const records = await createSqliteAuditRecordReader<SystemAgentTranscriptEntry>({
    scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
    env: opts.env,
  }).latest({ limit });
  return transcriptTail(
    records.toReversed().map((entry) => entry.value),
    opts.afterLastReset,
  );
}

function transcriptTail(
  entries: SystemAgentTranscriptEntry[],
  afterLastReset = false,
): SystemAgentTranscriptTurn[] {
  const resetIndex = afterLastReset ? entries.findLastIndex((turn) => turn.role === "reset") : -1;
  const window = afterLastReset ? entries.slice(resetIndex + 1) : entries;
  return window.filter((turn): turn is SystemAgentTranscriptTurn => turn.role !== "reset");
}
