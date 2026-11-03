// Durable rolling transcript for the machine-wide OpenClaw conversation.
import { randomUUID } from "node:crypto";
import {
  createSqliteAuditRecordReader,
  createSqliteAuditRecordWriter,
} from "../infra/sqlite-audit-record-store.async.js";

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

type TranscriptOptions = { env?: NodeJS.ProcessEnv; assertCurrent?: () => void };

/** Retain the turn's original store across inference, persistence, and publication. */
export function createSystemAgentTranscriptStore(opts: TranscriptOptions = {}) {
  const options = {
    ...opts,
    scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
    maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
  };
  const reader = createSqliteAuditRecordReader<SystemAgentTranscriptEntry>(options);
  const writer = createSqliteAuditRecordWriter<SystemAgentTranscriptEntry>(options);
  const appendTurn = (turn: SystemAgentTranscriptEntry) =>
    writer.register(`${turn.at}:${randomUUID()}`, turn, turn.at);
  return {
    assertCurrent: reader.assertCurrent,
    appendTurn,
    appendReset: () => appendTurn({ role: "reset", text: "", at: Date.now() }),
    async readTail(limit: number, afterLastReset = false): Promise<SystemAgentTranscriptTurn[]> {
      const records = await reader.latest({ limit });
      reader.assertCurrent();
      const entries = records.toReversed().map((entry) => entry.value);
      const resetIndex = afterLastReset
        ? entries.findLastIndex((turn) => turn.role === "reset")
        : -1;
      const window = afterLastReset ? entries.slice(resetIndex + 1) : entries;
      return window.filter((turn): turn is SystemAgentTranscriptTurn => turn.role !== "reset");
    },
  };
}

/** Read the newest window in conversational order without exposing reset markers. */
export async function readTranscriptTailAsync(
  limit: number,
  opts: TranscriptOptions & { afterLastReset?: boolean } = {},
): Promise<SystemAgentTranscriptTurn[]> {
  return await createSystemAgentTranscriptStore(opts).readTail(limit, opts.afterLastReset);
}
