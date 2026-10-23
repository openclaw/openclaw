import { isMainThread } from "node:worker_threads";
import { resolveDatabasePathKey } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveConcreteSessionStorePath } from "./paths.js";
import {
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

/** Resolves the canonical storage identity for runtime transcript access. */
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
  if (!isMainThread) {
    const { readSessionRuntimeTargetWorkerRequest } =
      await import("./session-entry-read.worker.js");
    const database = toDatabaseOptions(resolveSqliteTranscriptReadScope(bound));
    return {
      ...readSessionRuntimeTargetWorkerRequest({
        kind: "session-runtime-target",
        database: {
          agentId: database.agentId,
          path: database.path ?? resolveOpenClawAgentSqlitePath(database),
        },
        scope: bound,
        keyFormat: options.keyFormat,
      }).target,
      storePath,
    };
  }
  const [{ withSessionStoreReaderInWorker }, { projectionLane }] = await Promise.all([
    import("./session-entry-read-runtime.js"),
    import("./session-transcript-worker-resources.js"),
  ]);
  const target = await withSessionStoreReaderInWorker(
    bound,
    async ({ reader, database, logicalAgentId, continuation, assertCurrent }) => {
      // Entry facts do not prove ownership: cron base/run keys can share a session ID.
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
  return (await resolveSessionTranscriptRuntimeTarget(target)).sessionKey || undefined;
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
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
  // Unbound memory owners use lexical namespaces, not physical filesystem identities.
  return isIncognitoSessionKey(target.sessionKey)
    ? databasePath
    : resolveDatabasePathKey(databasePath);
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
