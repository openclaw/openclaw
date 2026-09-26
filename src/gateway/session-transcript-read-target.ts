import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import { resolveSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";

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
  const storePath = resolveConcreteSessionStorePath(scope.storePath);
  const target = storePath
    ? resolveSessionTranscriptReadTargetCore({ ...scope, storePath })
    : (
        await import("../config/sessions/session-accessor.transcript-target.js")
      ).resolveSessionTranscriptReadTarget(scope);
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
