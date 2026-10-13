import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  resolveConcreteSessionStorePath,
  resolveExplicitSessionStorePathForScope,
} from "./paths.js";
import { resolveSessionEntry } from "./session-accessor.sqlite-exact-read.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
} from "./session-accessor.types.js";

export function prepareSessionTranscriptReadTargetCore(
  scope: SessionTranscriptReadScope,
  resolveDefaultStorePath?: (scope: SessionTranscriptReadScope & { agentId: string }) => string,
) {
  const sessionKey = scope.sessionKey?.trim();
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${sessionKey}`);
  }
  const boundScope = {
    ...scope,
    agentId,
    sessionKey,
    storePath: resolveConcreteSessionStorePath(scope.storePath),
  };
  const storePath =
    resolveExplicitSessionStorePathForScope(boundScope) ?? resolveDefaultStorePath?.(boundScope);
  if (!storePath) {
    throw new Error("Transcript reads require a concrete session store path");
  }
  // Entry validation remains a reader-time operation; preparation carries only its scope.
  const entryValidationScope =
    sessionKey && scope.sessionEntry?.sessionId !== scope.sessionId
      ? { agentId, ...(scope.env ? { env: scope.env } : {}), sessionKey, storePath }
      : undefined;
  return { agentId, sessionKey, storePath, entryValidationScope };
}

/** Resolve a prepared store directly; only unbound callers need runtime configuration. */
export function resolveSessionTranscriptReadTargetCore(
  scope: SessionTranscriptReadScope,
  resolveDefaultStorePath?: (scope: SessionTranscriptReadScope & { agentId: string }) => string,
): SessionTranscriptReadTarget {
  const { agentId, sessionKey, storePath, entryValidationScope } =
    prepareSessionTranscriptReadTargetCore(scope, resolveDefaultStorePath);
  const resolved = entryValidationScope
    ? resolveSessionEntry(entryValidationScope, { readOnly: true })
    : undefined;
  const resolvedSessionKey = resolved?.normalizedKey ?? sessionKey;
  return {
    agentId,
    sessionId: scope.sessionId,
    storePath,
    ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
  };
}
