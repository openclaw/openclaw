import { isMainThread } from "node:worker_threads";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveConcreteSessionStorePath } from "./paths.js";
import { resolveSessionEntrySelection } from "./session-accessor.entry.js";
import { resolveSessionKeyBySessionId } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { resolveSessionTranscriptReadTargetCore } from "./session-accessor.transcript-read-target.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { SessionLifecycleRevisionExpectation } from "./session-transcript-turn-lifecycle.types.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

/** Binds runtime storage without changing keys that raw ownership checks and read fences validate. */
export function bindSessionTranscriptStoreScope<
  T extends Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
>(scope: T, config?: OpenClawConfig): T & { storePath: string } {
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
): Promise<
  SessionTranscriptRuntimeTarget & {
    selectedSessionId?: string | null;
    selectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  }
> {
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
  if (
    !isMainThread ||
    isIncognitoSessionKey(scope.sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(storePath, { agentId, env: bound.env })
  ) {
    return { ...readSessionTranscriptRuntimeTarget(bound, options), storePath };
  }
  const { withSessionStoreReaderInWorker } = await import("./session-entry-read-runtime.js");
  const target = await withSessionStoreReaderInWorker(
    bound,
    async ({ reader, database, logicalAgentId, continuation, assertCurrent }) => {
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
    { backing: true, dataOnly: true },
  );
  return { ...target, storePath };
}

/** The admitted reader resolves the window and canonical row in its captured physical store. */
export function readSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope & { agentId: string; storePath: string },
  options: {
    keyFormat?: "agent-qualified";
    databaseAgentId?: string;
    continuation?: CanonicalSessionReaderContinuation;
  } = {},
): Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>> {
  const { agentId, storePath } = scope;
  const persistedSessionKey = resolveSessionKeyBySessionId({
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
  const resolved = resolveSqliteTranscriptScope(target);
  return resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
}

export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  return resolveSessionTranscriptReadTargetCore(scope, resolveSessionStorePathForScope);
}
