import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { validateSessionId } from "../config/sessions/paths.js";
import { loadSqliteSessionEntries } from "../config/sessions/store-backend.sqlite.js";
import { normalizeSessionRowKey, resolveSessionRowEntry } from "../config/sessions/store-entry.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  updateLastRoute,
  upsertSessionEntry,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";

// Narrow SQLite session row helpers for channel hot paths.

export { resolveSessionRowEntry } from "../config/sessions/store-entry.js";
export { resolveAndPersistSessionTranscriptScope } from "../config/sessions/session-scope.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  updateLastRoute,
  upsertSessionEntry,
} from "../config/sessions/store.js";
export {
  getSqliteSessionTranscriptFrontier,
  loadSqliteSessionTranscriptDelta,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
export type {
  SqliteSessionTranscriptCursor,
  SqliteSessionTranscriptDelta,
  SqliteSessionTranscriptEvent,
  SqliteSessionTranscriptFrontier,
} from "../config/sessions/transcript-store.sqlite.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";

type LegacyStoreOptions = {
  storePath?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
};

type LegacyStoreTarget = {
  agentId: string;
  env: NodeJS.ProcessEnv;
};

const MULTI_STORE_PATH_SENTINEL = "(multiple)";

function resolveLegacyStoreTarget(options: LegacyStoreOptions = {}): LegacyStoreTarget {
  const env = options.env ?? process.env;
  if (options.agentId?.trim()) {
    return {
      agentId: normalizeAgentId(options.agentId),
      env,
    };
  }
  const storePath = options.storePath?.trim();
  if (!storePath || storePath === MULTI_STORE_PATH_SENTINEL) {
    return {
      agentId: DEFAULT_AGENT_ID,
      env,
    };
  }
  const candidate = path.resolve(storePath);
  if (path.basename(candidate) !== "sessions.json") {
    return {
      agentId: DEFAULT_AGENT_ID,
      env,
    };
  }
  const sessionsDir = path.dirname(candidate);
  if (path.basename(sessionsDir) !== "sessions") {
    return {
      agentId: DEFAULT_AGENT_ID,
      env,
    };
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return {
      agentId: DEFAULT_AGENT_ID,
      env,
    };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    env: {
      ...env,
      OPENCLAW_STATE_DIR: path.dirname(agentsDir),
    },
  };
}

function encodeSessionTopicId(topicId?: string | number): string | undefined {
  if (typeof topicId === "number") {
    return String(topicId);
  }
  if (typeof topicId === "string" && topicId.trim()) {
    return encodeURIComponent(topicId);
  }
  return undefined;
}

function resolveLegacySessionsDir(options: LegacyStoreOptions = {}): string {
  if (options.storePath?.trim() && options.storePath !== MULTI_STORE_PATH_SENTINEL) {
    return path.dirname(path.resolve(options.storePath));
  }
  return path.dirname(resolveStorePath(undefined, options));
}

// Deprecated compatibility surface retained for older plugin imports while the
// runtime remains SQLite-backed under the hood.
export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  const target = resolveLegacyStoreTarget({ storePath });
  return loadSqliteSessionEntries(target);
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const { normalizedKey } = resolveSessionRowEntry({
    entries: params.store,
    sessionKey: trimmedKey,
  });
  const legacyKeySet = new Set<string>();
  if (
    trimmedKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  let existing =
    params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    if (normalizeSessionRowKey(candidateKey) !== normalizedKey) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}

export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeTopicId = encodeSessionTopicId(topicId);
  const fileName =
    safeTopicId !== undefined
      ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
      : `${safeSessionId}.jsonl`;
  return path.resolve(sessionsDir, fileName);
}

export function resolveStorePath(
  store?: string,
  options: { agentId?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const agentId = normalizeAgentId(options.agentId ?? DEFAULT_AGENT_ID);
  const env = options.env ?? process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  if (!store) {
    return path.join(resolveStateDir(env, homedir), "agents", agentId, "sessions", "sessions.json");
  }
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(
        expandHomePrefix(expanded, {
          home: resolveRequiredHomeDir(env, homedir),
          env,
          homedir,
        }),
      );
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(store, {
        home: resolveRequiredHomeDir(env, homedir),
        env,
        homedir,
      }),
    );
  }
  return path.resolve(store);
}

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    params.sessionStore[params.sessionKey] ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
  const sessionFile = params.fallbackSessionFile?.trim()
    ? path.resolve(params.fallbackSessionFile)
    : resolveSessionTranscriptPathInDir(
        params.sessionId,
        params.sessionsDir ?? resolveLegacySessionsDir(params),
      );
  const sessionEntry: SessionEntry = {
    ...baseEntry,
    sessionId: params.sessionId,
    updatedAt: now,
    sessionStartedAt:
      baseEntry.sessionId === params.sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  params.sessionStore[params.sessionKey] = sessionEntry;
  const target = resolveLegacyStoreTarget(params);
  upsertSessionEntry({
    agentId: target.agentId,
    env: target.env,
    sessionKey: params.sessionKey,
    entry: sessionEntry,
  });
  return { sessionFile, sessionEntry };
}

export function clearSessionStoreCacheForTest(): void {
  // SQLite-backed sessions no longer maintain the legacy sessions.json cache.
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const target = resolveLegacyStoreTarget({ storePath });
  const existingKeys = new Set(Object.keys(loadSqliteSessionEntries(target)));
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({
      agentId: target.agentId,
      env: target.env,
      sessionKey,
      entry,
    });
    existingKeys.delete(sessionKey);
  }
  for (const sessionKey of existingKeys) {
    deleteSessionEntry({
      agentId: target.agentId,
      env: target.env,
      sessionKey,
    });
  }
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  const store = loadSessionStore(storePath);
  const result = await mutator(store);
  await saveSessionStore(storePath, store);
  return result;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<SessionEntry | null> {
  const store = loadSessionStore(params.storePath);
  const resolved = resolveSessionStoreEntry({
    store,
    sessionKey: params.sessionKey,
  });
  if (!resolved.existing) {
    return null;
  }
  const patch = await params.update(structuredClone(resolved.existing));
  if (!patch) {
    return resolved.existing;
  }
  const next = {
    ...resolved.existing,
    ...patch,
  };
  for (const legacyKey of resolved.legacyKeys) {
    delete store[legacyKey];
  }
  delete store[resolved.normalizedKey];
  store[resolved.normalizedKey] = next;
  await saveSessionStore(params.storePath, store);
  return next;
}
