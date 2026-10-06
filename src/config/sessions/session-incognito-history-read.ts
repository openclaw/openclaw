import path from "node:path";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "./session-incognito-history-contract.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type IncognitoSessionHistoryBinding = {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
};

export async function readIncognitoSessionHistory<Key extends keyof IncognitoHistoryOperations>(
  binding: IncognitoSessionHistoryBinding,
  scope: SessionTranscriptReadScope,
  command: (target: IncognitoHistoryTarget) => {
    type: Key;
    input: IncognitoHistoryOperations[Key]["input"];
  },
  signal?: AbortSignal,
): Promise<IncognitoHistoryOperations[Key]["output"]> {
  const prepared = prepareIncognitoSessionHistoryRead(binding, scope, signal);
  const result = await prepared.actor.sessions.history(
    prepared.authority,
    command(prepared.target),
    signal,
  );
  prepared.authority.assertCurrent();
  return result;
}

/** Inactive until atomic activation supplies the original actor instead of native routing. */
export function prepareIncognitoSessionHistoryRead(
  binding: IncognitoSessionHistoryBinding,
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
) {
  const { actor, authority } = binding;
  const target = structuredClone(binding.target);
  const suppliedPath = scope.storePath === undefined ? undefined : path.resolve(scope.storePath);
  const selectedPath =
    isIncognitoSessionKey(scope.sessionKey ?? target.sessionKey) &&
    (scope.env !== undefined || (suppliedPath !== undefined && suppliedPath !== actor.path))
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: actor.agentId, env: scope.env })
      : suppliedPath;
  if (
    scope.sessionId !== target.sessionId ||
    (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
    (scope.agentId !== undefined && scope.agentId !== actor.agentId) ||
    (selectedPath !== undefined && selectedPath !== actor.path) ||
    (scope.sessionEntry?.sessionId !== undefined &&
      scope.sessionEntry.sessionId !== target.sessionId)
  ) {
    throw new Error("Incognito history read belongs to another session or store");
  }
  const admission =
    target.admission ??
    resolveSessionTranscriptReadFence({
      agentId: actor.agentId,
      sessionId: target.sessionId,
    });
  target.admission = admission ? { ...admission } : undefined;
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    authority.assertCurrent();
    claim.assertCurrent();
    actor.assertReadable();
  };
  assertCurrent();
  return {
    actor,
    target,
    authority: {
      assertCurrent,
      authorize: (stage, facts) => authority.authorize?.(stage, facts),
    } satisfies IncognitoSessionAuthority,
  };
}
