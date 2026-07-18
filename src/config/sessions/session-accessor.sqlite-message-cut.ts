import { randomUUID } from "node:crypto";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSqliteSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import { loadSqliteTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  formatSqliteSessionMarkerForScope,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import { inheritSessionSelection } from "./session-entry-selection.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { parseSqliteSessionFileMarker } from "./sqlite-marker.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import type { SessionEntry } from "./types.js";

type MessageCut = {
  editorText?: string;
  parentId: string | null;
  prefix: TranscriptEvent[];
};

export async function rewindSqliteSessionToMessage(
  params: SessionMessageCutMutationParams,
): Promise<SessionMessageCutMutationResult> {
  return await mutateSqliteSessionAtMessage(params, "rewind");
}

export async function forkSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
): Promise<SessionMessageCutMutationResult> {
  return await mutateSqliteSessionAtMessage(params, "fork");
}

async function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "fork" | "rewind",
): Promise<SessionMessageCutMutationResult> {
  const canonicalSourceKey = normalizeSqliteSessionKey(params.sessionKey);
  const sourceKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const targetKey =
    mode === "rewind"
      ? sourceKey
      : normalizeSqliteSessionKey(params.targetKey ?? params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SessionMessageCutMutationResult = { status: "failed" };
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sourceKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
      result = mutateSqliteSessionAtMessageInTransaction(database, resolved, {
        entryId: params.entryId,
        canonicalSourceKey,
        mode,
        sourceKey,
        targetKey,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result;
  });
}

function mutateSqliteSessionAtMessageInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    canonicalSourceKey: string;
    entryId: string;
    mode: "fork" | "rewind";
    sourceKey: string;
    targetKey: string;
  },
): SessionMessageCutMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (currentEntry.sessionFile?.trim() && !parseSqliteSessionFileMarker(currentEntry.sessionFile)) {
    return { status: "unsupported-storage" };
  }
  const events = loadSqliteTranscriptEventsFromDatabase(database, currentEntry.sessionId);
  const cut = resolveMessageCut(events, params.entryId);
  if ("status" in cut) {
    return cut;
  }

  const nextSessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId: nextSessionId,
    sessionKey: params.targetKey,
  };
  const nextSessionFile = formatSqliteSessionMarkerForScope(targetScope);
  const header = createSessionTranscriptHeader({
    cwd: readTranscriptHeaderCwd(events),
    sessionId: nextSessionId,
  });
  const nextEvents =
    params.mode === "fork"
      ? [header, ...cut.prefix]
      : [
          header,
          ...events.filter((event) => !isSessionHeader(event)),
          {
            type: "leaf",
            id: uniqueEntryId(events),
            parentId: readLastEventId(events),
            timestamp: new Date().toISOString(),
            targetId: cut.parentId,
          },
        ];
  appendTranscriptEventsInTransaction(database, targetScope, nextEvents);
  if (params.mode === "rewind") {
    reconcileSessionTranscriptIndexInTransaction(database.db, nextSessionId);
  }

  // Rotating transcript identity fences stale live managers: later snapshot-replace writes
  // target the old session and cannot erase this leaf repoint from the active session.
  const nextEntry = cloneMessageCutSessionEntry({
    currentEntry,
    forked: params.mode === "fork",
    nextSessionFile,
    nextSessionId,
    parentSessionKey: params.mode === "fork" ? params.canonicalSourceKey : undefined,
  });
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    entry: nextEntry,
    ...(cut.editorText ? { editorText: cut.editorText } : {}),
  };
}

function resolveMessageCut(
  events: readonly TranscriptEvent[],
  entryId: string,
): MessageCut | Exclude<SessionMessageCutMutationResult, { status: "created" }> {
  const tree = scanSessionTranscriptTree(events);
  const target = tree.byId.get(entryId);
  if (!target) {
    return { status: "missing-entry" };
  }
  const record = asRecord(target.entry);
  const message = asRecord(record?.message);
  if (record?.type !== "message" || message?.role !== "user") {
    return { status: "not-user-message" };
  }
  const activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const targetIndex = activePath.findIndex((node) => node.id === entryId);
  if (targetIndex < 0) {
    return { status: "off-active-path" };
  }
  const prefix: TranscriptEvent[] = [];
  for (const node of activePath.slice(0, targetIndex)) {
    const entry = asRecord(node.entry);
    // Spread (not Object.assign) so a parsed own `__proto__` key stays an inert
    // data property instead of rebinding the copy's prototype.
    prefix.push(
      entry && entry.parentId !== node.parentId
        ? ({ ...entry, parentId: node.parentId } as TranscriptEvent)
        : node.entry,
    );
  }
  return {
    editorText: extractEditorText(message.content),
    parentId: target.parentId,
    prefix,
  };
}

function cloneMessageCutSessionEntry(params: {
  currentEntry: SessionEntry;
  forked: boolean;
  nextSessionFile: string;
  nextSessionId: string;
  parentSessionKey?: string;
}): SessionEntry {
  const baseEntry = params.forked
    ? inheritSessionSelection(params.currentEntry)
    : params.currentEntry;
  return {
    ...baseEntry,
    sessionId: params.nextSessionId,
    sessionFile: params.nextSessionFile,
    lifecycleRevision: params.forked ? randomUUID() : params.currentEntry.lifecycleRevision,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens: undefined,
    totalTokensFresh: undefined,
    // A rotated transcript cannot resume provider/runtime identity from the old tail.
    // Clear transcript-derived accounting too so the next turn rebuilds canonical state.
    contextTokens: undefined,
    contextBudgetStatus: undefined,
    compactionCount: undefined,
    compactionCheckpoints: undefined,
    memoryFlushAt: undefined,
    memoryFlushCompactionCount: undefined,
    memoryFlushContextHash: undefined,
    memoryFlushFailureCount: undefined,
    memoryFlushLastFailedAt: undefined,
    memoryFlushLastFailureError: undefined,
    cliSessionBindings: undefined,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
    agentHarnessId: undefined,
    modelSelectionLocked: undefined,
    skillsSnapshot: undefined,
    systemPromptReport: undefined,
    restartRecoveryRuns: undefined,
    restartRecoveryForceSafeTools: undefined,
    abortCutoffMessageSid: undefined,
    abortCutoffTimestamp: undefined,
    usageFamilyKey: params.forked ? undefined : params.currentEntry.usageFamilyKey,
    usageFamilySessionIds: params.forked ? undefined : params.currentEntry.usageFamilySessionIds,
    ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
  };
}

function extractEditorText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSessionHeader(event: unknown): boolean {
  return asRecord(event)?.type === "session";
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const cwd = asRecord(events.find(isSessionHeader))?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function readLastEventId(events: readonly TranscriptEvent[]): string | null {
  const id = asRecord(events.findLast((event) => !isSessionHeader(event)))?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function uniqueEntryId(events: readonly TranscriptEvent[]): string {
  const ids = new Set(
    events.flatMap((event) => {
      const id = asRecord(event)?.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
}
