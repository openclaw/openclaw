import { isMainThread } from "node:worker_threads";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveConcreteSessionStorePath } from "./paths.js";
import { resolveSessionEntrySelection } from "./session-accessor.entry.js";
import { readSessionKeyBySessionIdInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { resolveSessionKeyBySessionId } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteSessionKey,
  resolveSqliteTranscriptScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { resolveSessionTranscriptReadTargetCore } from "./session-accessor.transcript-read-target.js";
import type {
  ResolvedSessionTranscriptRuntimeTarget,
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { readRetainedSessionEntryFacts } from "./session-entry-read-facts.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

/** Binds runtime storage without changing keys that raw ownership checks and read fences validate. */
export function bindSessionTranscriptStoreScope<
  T extends Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
>(scope: T, config?: OpenClawConfig): T & { storePath: string } {
  const memory =
    !scope.sessionKey || isIncognitoSessionKey(scope.sessionKey)
      ? captureSessionActorStorageOwner(scope)
      : undefined;
  if (memory) {
    return { ...scope, storePath: memory.path };
  }
  return {
    ...scope,
    storePath: resolveSessionStorePathForScope(
      { ...scope, storePath: resolveConcreteSessionStorePath(scope.storePath) },
      config,
    ),
  };
}

/** Resolves the canonical SQLite identity for runtime transcript access. */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
  config?: OpenClawConfig,
  options: { keyFormat?: "agent-qualified" } = {},
): Promise<ResolvedSessionTranscriptRuntimeTarget> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    const current = options.keyFormat ? memory.currentEntry() : undefined;
    return {
      ...memory.target,
      ...(options.keyFormat
        ? {
            selectedSessionId: current?.sessionId ?? null,
            selectedLifecycleRevision: current?.lifecycleRevision ?? null,
          }
        : {}),
    };
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const { storePath } = bindSessionTranscriptStoreScope({ ...scope, agentId }, config);
  const bound = captureSessionTranscriptTargetBinding({
    ...scope,
    agentId,
    storePath,
  });
  const incognito = isMainThread ? captureIncognitoSessionSource(bound) : undefined;
  if (incognito && "kind" in incognito) {
    incognito.assertCurrent();
    return {
      ...bound,
      ...(options.keyFormat ? { selectedSessionId: null, selectedLifecycleRevision: null } : {}),
    };
  }
  if (incognito) {
    incognito.admissionSignal?.throwIfAborted();
    const sessionKey = resolveSqliteSessionKey(bound.sessionKey, agentId);
    if (!sessionKey && !options.keyFormat) {
      // Marker-only history resolves retained windows without a current entry key.
      const persistedSessionKey = await incognito.actor.sessions.transcript(
        { assertCurrent: () => incognito.actor.assertReadable() },
        { type: "session.keyById.read", input: { sessionId: bound.sessionId } },
        incognito.admissionSignal,
      );
      return {
        agentId,
        sessionId: bound.sessionId,
        sessionKey: persistedSessionKey ?? "",
        storePath: incognito.actor.path,
      };
    }
    return incognito.actor.sessions.transcript(
      { assertCurrent: () => incognito.actor.assertReadable() },
      {
        type: "session.runtimeTarget.read",
        input: {
          sessionKey,
          sessionId: bound.sessionId,
          fence: {},
          ...options,
        },
      },
      incognito.admissionSignal,
    );
  }
  if (
    !isMainThread ||
    isIncognitoSessionKey(scope.sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(storePath, { agentId, env: bound.env })
  ) {
    return { ...readSessionTranscriptRuntimeTarget(bound, options), storePath };
  }
  const [{ withSessionStoreReaderInWorker }, { projectionLane }] = await Promise.all([
    import("./session-entry-read-runtime.js"),
    import("./session-transcript-worker-resources.js"),
  ]);
  const target = await withSessionStoreReaderInWorker(
    bound,
    async ({ reader, database, logicalAgentId, continuation, assertCurrent }) => {
      const sessionKey = resolveSqliteSessionKey(bound.sessionKey, logicalAgentId);
      const current = sessionKey
        ? readRetainedSessionEntryFacts(database, { sessionKeys: [sessionKey] })
        : undefined;
      const entry = current?.entries.find((row) => row.sessionKey === sessionKey)?.entry;
      if (entry?.sessionId === bound.sessionId) {
        assertCurrent();
        return {
          agentId: logicalAgentId,
          sessionId: bound.sessionId,
          sessionKey,
          storePath: database.path,
          ...(options.keyFormat
            ? {
                selectedSessionId: entry.sessionId,
                selectedLifecycleRevision: entry.lifecycleRevision ?? null,
              }
            : {}),
        };
      }
      // Historical windows and keyless lookups need the persisted session-ID index.
      const selected = await reader.readRuntimeTarget({
        scope: {
          agentId: logicalAgentId,
          env: database.env,
          sessionId: bound.sessionId,
          sessionKey: bound.sessionKey,
          storePath: database.path,
        },
        keyFormat: options.keyFormat,
        continuation,
      });
      assertCurrent();
      return selected;
    },
    { backing: true, lane: projectionLane, dataOnly: true },
  );
  return { ...target, storePath };
}

/** Resolve only a persisted window's key through the captured storage owner. */
export async function resolveSessionKeyBySessionIdAsync(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): Promise<string | undefined> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    return memory.missing ? undefined : memory.target.sessionKey;
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const target = { ...scope, agentId: resolved.agentId, sessionKey: "" };
  const source = isMainThread ? captureIncognitoSessionSource(target) : undefined;
  if (source && "kind" in source) {
    source.assertCurrent();
    return undefined;
  }
  if (source) {
    source.admissionSignal?.throwIfAborted();
    return source.actor.sessions.transcript(
      { assertCurrent: () => source.actor.assertReadable() },
      { type: "session.keyById.read", input: { sessionId: scope.sessionId } },
      source.admissionSignal,
    );
  }
  return (await resolveSessionTranscriptRuntimeTarget(target)).sessionKey || undefined;
}

/** The admitted reader resolves the window and canonical row in its captured physical store. */
export function readSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope & { agentId: string; storePath: string },
  options: {
    keyFormat?: "agent-qualified";
    databaseAgentId?: string;
    continuation?: CanonicalSessionReaderContinuation;
  } = {},
  database?: Pick<OpenClawAgentDatabase, "db">,
): Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>> {
  const { agentId, storePath } = scope;
  const persistedSessionKey = database
    ? readSessionKeyBySessionIdInDatabase(database, scope.sessionId)
    : resolveSessionKeyBySessionId({
        agentId: options.databaseAgentId ?? agentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionId: scope.sessionId,
        storePath,
      });
  const selected =
    persistedSessionKey && !options.keyFormat
      ? undefined
      : resolveSessionEntrySelection(
          {
            agentId,
            ...(scope.env ? { env: scope.env } : {}),
            sessionKey: persistedSessionKey ?? scope.sessionKey,
            storePath,
          },
          {
            readOnly: true,
            keyFormat: options.keyFormat,
            allowCanonicalMove: !persistedSessionKey,
            databaseAgentId: options.databaseAgentId,
            continuation: options.continuation,
          },
        );
  const sessionKey = persistedSessionKey ?? selected?.normalizedKey ?? scope.sessionKey;
  return {
    agentId,
    sessionId: scope.sessionId,
    sessionKey,
    storePath,
    ...(options.keyFormat
      ? {
          selectedSessionId: selected?.existing?.sessionId ?? null,
          selectedLifecycleRevision: selected?.existing?.lifecycleRevision ?? null,
        }
      : {}),
  };
}

/** Resolves the physical agent database that owns one runtime transcript. */
export function resolveSessionTranscriptDatabasePath(
  target: SessionTranscriptRuntimeTarget,
): string {
  const memory = isIncognitoSessionKey(target.sessionKey)
    ? captureSessionActorStorageOwner(target)
    : undefined;
  if (memory) {
    return memory.path;
  }
  const resolved = resolveSqliteTranscriptScope(target);
  return resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
}

export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    return memory.target;
  }
  return resolveSessionTranscriptReadTargetCore(scope, resolveSessionStorePathForScope);
}
