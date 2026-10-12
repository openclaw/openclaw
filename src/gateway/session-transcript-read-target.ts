import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { prepareSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";

export type ResolvedTranscriptReadTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export async function resolveTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): Promise<ResolvedTranscriptReadTarget> {
  const memory = captureSessionActorTranscriptRead(scope);
  const target =
    memory?.target ??
    (() => {
      const prepared = prepareSessionTranscriptReadTargetCore(
        scope,
        resolveSessionStorePathForScope,
      );
      // This descriptor only needs canonical key spelling; the transcript reader owns validation.
      return {
        agentId: prepared.agentId,
        sessionId: scope.sessionId,
        sessionKey: prepared.entryValidationScope
          ? resolveSqliteSessionKey(prepared.entryValidationScope.sessionKey, prepared.agentId)
          : prepared.sessionKey,
        storePath: prepared.storePath,
      };
    })();
  return {
    agentId: target.agentId,
    sessionFile: target.sessionKey ?? target.sessionId,
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    storePath: target.storePath,
  };
}

export function toTranscriptReadScope(
  target: Pick<ResolvedTranscriptReadTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">,
): SessionTranscriptReadScope {
  return {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    ...(target.storePath ? { storePath: target.storePath } : {}),
  };
}
