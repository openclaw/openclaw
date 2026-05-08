import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  SessionManager,
  type FileEntry as PiSessionFileEntry,
  type SessionHeader,
} from "../agents/transcript/session-transcript-contract.js";
import { patchSessionEntry } from "../config/sessions.js";
import type {
  SessionCompactionCheckpoint,
  SessionCompactionCheckpointReason,
  SessionEntry,
} from "../config/sessions.js";
import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
} from "../config/sessions/paths.js";
import {
  deleteSqliteSessionTranscript,
  deleteSqliteSessionTranscriptSnapshot,
  loadSqliteSessionTranscriptEvents,
  recordSqliteSessionTranscriptSnapshot,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveGatewaySessionDatabaseTarget } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;
export const MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export type CapturedCompactionCheckpointSnapshot = {
  sessionId: string;
  sessionFile?: string;
  leafId: string;
};

type ForkedCompactionCheckpointTranscript = {
  sessionId: string;
  sessionFile: string;
};

function trimSessionCheckpoints(checkpoints: SessionCompactionCheckpoint[] | undefined): {
  kept: SessionCompactionCheckpoint[] | undefined;
  removed: SessionCompactionCheckpoint[];
} {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { kept: undefined, removed: [] };
  }
  const kept = checkpoints.slice(-MAX_COMPACTION_CHECKPOINTS_PER_SESSION);
  return {
    kept,
    removed: checkpoints.slice(0, Math.max(0, checkpoints.length - kept.length)),
  };
}

function sessionStoreCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}

export function resolveSessionCompactionCheckpointReason(params: {
  trigger?: "budget" | "overflow" | "manual";
  timedOut?: boolean;
}): SessionCompactionCheckpointReason {
  if (params.trigger === "manual") {
    return "manual";
  }
  if (params.timedOut) {
    return "timeout-retry";
  }
  if (params.trigger === "overflow") {
    return "overflow-retry";
  }
  return "auto-threshold";
}

function cloneTranscriptEvents(events: unknown[]): PiSessionFileEntry[] | null {
  const entries = events.filter((event): event is PiSessionFileEntry =>
    Boolean(event && typeof event === "object"),
  );
  const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
    return null;
  }
  return structuredClone(entries);
}

function loadTranscriptEntriesFromSqlite(params: {
  agentId?: string;
  sessionId?: string;
  sessionFile?: string;
}): PiSessionFileEntry[] | null {
  let agentId = params.agentId?.trim() || DEFAULT_AGENT_ID;
  let sessionId = params.sessionId?.trim();
  if (!sessionId && params.sessionFile?.trim()) {
    const scope = resolveSqliteSessionTranscriptScopeForPath({
      transcriptPath: params.sessionFile,
    });
    agentId = scope?.agentId ?? agentId;
    sessionId = scope?.sessionId;
  }
  if (!sessionId) {
    return null;
  }
  return cloneTranscriptEvents(
    loadSqliteSessionTranscriptEvents({
      agentId,
      sessionId,
    }).map((entry) => entry.event),
  );
}

function transcriptEventsByteLength(events: readonly PiSessionFileEntry[]): number {
  let total = 0;
  for (const event of events) {
    total += Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
  }
  return total;
}

function latestEntryId(entries: readonly PiSessionFileEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; id?: unknown } | undefined;
    if (entry?.type === "session") {
      return null;
    }
    if (typeof entry?.id === "string" && entry.id.trim()) {
      return entry.id.trim();
    }
  }
  return null;
}

function createCheckpointVirtualTranscriptPath(params: {
  sourceFile?: string;
  checkpointId: string;
}): string | undefined {
  const sourceFile = params.sourceFile?.trim();
  if (!sourceFile) {
    return undefined;
  }
  if (isSqliteSessionTranscriptLocator(sourceFile)) {
    const scope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sourceFile });
    return createSqliteSessionTranscriptLocator({
      agentId: scope?.agentId ?? DEFAULT_AGENT_ID,
      sessionId: params.checkpointId,
    });
  }
  const parsed = path.parse(sourceFile);
  return path.join(
    parsed.dir,
    `${parsed.name}.checkpoint.${params.checkpointId}${parsed.ext || ".jsonl"}`,
  );
}

export async function readSessionLeafIdFromTranscriptAsync(
  sessionFile: string,
  maxBytes = MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
): Promise<string | null> {
  const entries = loadTranscriptEntriesFromSqlite({ sessionFile });
  if (!entries || transcriptEventsByteLength(entries) > maxBytes) {
    return null;
  }
  return latestEntryId(entries);
}

export async function forkCompactionCheckpointTranscriptAsync(params: {
  sourceFile?: string;
  sourceSessionId?: string;
  agentId?: string;
  targetCwd?: string;
  sessionDir?: string;
}): Promise<ForkedCompactionCheckpointTranscript | null> {
  const sourceFile = params.sourceFile?.trim();
  const entries = loadTranscriptEntriesFromSqlite({
    agentId: params.agentId,
    sessionId: params.sourceSessionId,
    sessionFile: sourceFile,
  });
  if (!entries) {
    return null;
  }
  const sourceHeader = entries[0] as SessionHeader | undefined;
  if (!sourceHeader) {
    return null;
  }
  migrateSessionEntries(entries);

  const targetCwd = params.targetCwd ?? sourceHeader.cwd ?? process.cwd();
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sourceScope = sourceFile
    ? resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sourceFile })
    : undefined;
  const agentId = params.agentId?.trim() || sourceScope?.agentId || DEFAULT_AGENT_ID;
  const sessionFile =
    sourceFile && isSqliteSessionTranscriptLocator(sourceFile)
      ? createSqliteSessionTranscriptLocator({ agentId, sessionId })
      : (() => {
          const sessionDir =
            params.sessionDir ?? (sourceFile ? path.dirname(sourceFile) : process.cwd());
          const fileTimestamp = timestamp.replace(/[:.]/g, "-");
          return path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
        })();
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
    ...(sourceFile ? { parentSession: sourceFile } : {}),
  };

  try {
    replaceSqliteSessionTranscriptEvents({
      agentId,
      sessionId,
      transcriptPath: sessionFile,
      events: [
        header,
        ...entries.filter((entry) => (entry as { type?: unknown }).type !== "session"),
      ],
    });
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

/**
 * Capture a bounded pre-compaction transcript snapshot without blocking the
 * Gateway event loop on synchronous file reads/copies.
 */
export async function captureCompactionCheckpointSnapshotAsync(params: {
  agentId?: string;
  sessionManager?: Pick<SessionManager, "getEntries" | "getHeader" | "getLeafId">;
  sessionFile: string;
  maxBytes?: number;
}): Promise<CapturedCompactionCheckpointSnapshot | null> {
  const getLeafId =
    params.sessionManager && typeof params.sessionManager.getLeafId === "function"
      ? params.sessionManager.getLeafId.bind(params.sessionManager)
      : null;
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile || (params.sessionManager && !getLeafId)) {
    return null;
  }
  const liveLeafId = getLeafId ? getLeafId() : undefined;
  if (getLeafId && !liveLeafId) {
    return null;
  }
  const maxBytes = params.maxBytes ?? MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
  const entries = params.sessionManager
    ? cloneTranscriptEvents([
        params.sessionManager.getHeader(),
        ...params.sessionManager.getEntries(),
      ])
    : loadTranscriptEntriesFromSqlite({
        agentId: params.agentId,
        sessionFile,
      });
  if (!entries || transcriptEventsByteLength(entries) > maxBytes) {
    return null;
  }
  const sourceHeader = entries[0] as SessionHeader | undefined;
  const leafId = liveLeafId ?? latestEntryId(entries);
  if (!sourceHeader?.id || !leafId) {
    return null;
  }
  const snapshotSessionId = randomUUID();
  const snapshotFile = createCheckpointVirtualTranscriptPath({
    sourceFile: sessionFile,
    checkpointId: snapshotSessionId,
  });
  const sourceScope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sessionFile });
  const snapshotAgentId = params.agentId?.trim() || sourceScope?.agentId || DEFAULT_AGENT_ID;
  const snapshotHeader: SessionHeader = {
    ...sourceHeader,
    id: snapshotSessionId,
    timestamp: new Date().toISOString(),
    parentSession: sessionFile,
  };
  replaceSqliteSessionTranscriptEvents({
    agentId: snapshotAgentId,
    sessionId: snapshotSessionId,
    transcriptPath: snapshotFile,
    events: [
      snapshotHeader,
      ...entries.filter((entry) => (entry as { type?: unknown }).type !== "session"),
    ],
  });
  recordSqliteSessionTranscriptSnapshot({
    agentId: snapshotAgentId,
    sessionId: sourceHeader.id,
    snapshotId: snapshotSessionId,
    reason: "pre-compaction",
    eventCount: entries.length,
    metadata: {
      leafId,
      sourceTranscriptPath: sessionFile,
      ...(snapshotFile ? { snapshotTranscriptPath: snapshotFile } : {}),
    },
  });
  return {
    sessionId: snapshotSessionId,
    sessionFile: snapshotFile,
    leafId,
  };
}

export async function cleanupCompactionCheckpointSnapshot(
  snapshot: CapturedCompactionCheckpointSnapshot | null | undefined,
): Promise<void> {
  void snapshot;
}

export async function persistSessionCompactionCheckpoint(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  reason: SessionCompactionCheckpointReason;
  snapshot: CapturedCompactionCheckpointSnapshot;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  postSessionFile?: string;
  postLeafId?: string;
  postEntryId?: string;
  createdAt?: number;
}): Promise<SessionCompactionCheckpoint | null> {
  const target = resolveGatewaySessionDatabaseTarget({
    cfg: params.cfg,
    key: params.sessionKey,
  });
  const createdAt = params.createdAt ?? Date.now();
  const checkpoint: SessionCompactionCheckpoint = {
    checkpointId: randomUUID(),
    sessionKey: target.canonicalKey,
    sessionId: params.sessionId,
    createdAt,
    reason: params.reason,
    ...(typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {}),
    ...(typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {}),
    ...(params.summary?.trim() ? { summary: params.summary.trim() } : {}),
    ...(params.firstKeptEntryId?.trim()
      ? { firstKeptEntryId: params.firstKeptEntryId.trim() }
      : {}),
    preCompaction: {
      sessionId: params.snapshot.sessionId,
      ...(params.snapshot.sessionFile?.trim()
        ? { sessionFile: params.snapshot.sessionFile.trim() }
        : {}),
      leafId: params.snapshot.leafId,
    },
    postCompaction: {
      sessionId: params.sessionId,
      ...(params.postSessionFile?.trim() ? { sessionFile: params.postSessionFile.trim() } : {}),
      ...(params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {}),
      ...(params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}),
    },
  };

  let stored = false;
  let trimmedCheckpoints:
    | {
        kept: SessionCompactionCheckpoint[] | undefined;
        removed: SessionCompactionCheckpoint[];
      }
    | undefined;
  await patchSessionEntry({
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    update: (existing) => {
      if (!existing.sessionId) {
        return null;
      }
      const checkpoints = sessionStoreCheckpoints(existing);
      checkpoints.push(checkpoint);
      trimmedCheckpoints = trimSessionCheckpoints(checkpoints);
      stored = true;
      return {
        updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
        compactionCheckpoints: trimmedCheckpoints.kept,
      };
    },
  });

  if (!stored) {
    log.warn("skipping compaction checkpoint persist: session not found", {
      sessionKey: params.sessionKey,
    });
    return null;
  }
  for (const removed of trimmedCheckpoints?.removed ?? []) {
    deleteSqliteSessionTranscriptSnapshot({
      agentId: target.agentId,
      sessionId: removed.sessionId,
      snapshotId: removed.preCompaction.sessionId,
    });
    deleteSqliteSessionTranscript({
      agentId: target.agentId,
      sessionId: removed.preCompaction.sessionId,
    });
  }
  return checkpoint;
}

export function listSessionCompactionCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return sessionStoreCheckpoints(entry).toSorted((a, b) => b.createdAt - a.createdAt);
}

export function getSessionCompactionCheckpoint(params: {
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined;
  checkpointId: string;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId) {
    return undefined;
  }
  return listSessionCompactionCheckpoints(params.entry).find(
    (checkpoint) => checkpoint.checkpointId === checkpointId,
  );
}
