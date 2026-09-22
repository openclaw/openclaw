import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import type { SessionInitResult } from "./session.js";

export async function prepareReplySessionDiffBaseline(params: {
  agentId: string;
  workspaceDir: string;
  sessionState: Pick<
    SessionInitResult,
    | "sessionEntry"
    | "sessionEntryHandle"
    | "sessionStore"
    | "isNewSession"
    | "sessionKey"
    | "storePath"
  >;
}): Promise<void> {
  const { sessionState } = params;
  const entry = await ensureSessionDiffBaseline({
    agentId: params.agentId,
    cwd:
      normalizeOptionalString(sessionState.sessionEntry.spawnedCwd) ??
      normalizeOptionalString(sessionState.sessionEntry.spawnedWorkspaceDir) ??
      params.workspaceDir,
    entry: sessionState.sessionEntry,
    isNewSession: sessionState.isNewSession,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
  });
  sessionState.sessionEntry = entry;
  sessionState.sessionEntryHandle.replaceCurrent(entry);
  sessionState.sessionStore[sessionState.sessionKey] = entry;
}
