import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { sessionStoreEntry } from "./test/server-sessions.test-helpers.js";

export async function seedSessionEntry(params: {
  agentId?: string;
  entry: ReturnType<typeof sessionStoreEntry>;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await upsertSessionEntryCore(
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.entry,
  );
}

export function loadSessionEntry(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
}): ReturnType<typeof loadAccessorSessionEntry> {
  return loadAccessorSessionEntry({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    readConsistency: "latest",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

export async function seedTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  totalLines: number;
}): Promise<void> {
  const scope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  if (params.totalLines <= 0) {
    return;
  }
  await appendTranscriptEvent(scope, {
    type: "session",
    version: 3,
    id: params.sessionId,
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  for (let index = 0; index < params.totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: {
        role: "user",
        content: `line-${index}`,
        timestamp: index,
      },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
    });
  }
}

export async function loadTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  const rows = await loadTranscriptEvents({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  return rows.map((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {},
  );
}

export function isCompactOperationEvent(message: unknown, phase: "start" | "end") {
  const candidate = message as {
    event?: unknown;
    payload?: { operation?: unknown; phase?: unknown };
    type?: unknown;
  };
  return (
    candidate.type === "event" &&
    candidate.event === "session.operation" &&
    candidate.payload?.operation === "compact" &&
    candidate.payload?.phase === phase
  );
}
