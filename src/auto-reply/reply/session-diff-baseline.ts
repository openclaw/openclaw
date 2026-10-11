import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import type { SessionInitResult } from "./session-init.types.js";

export async function prepareReplySessionDiffBaseline(params: {
  agentId: string;
  workspaceDir: string;
  sessionState: Pick<
    SessionInitResult,
    "sessionEntry" | "sessionEntryHandle" | "isNewSession" | "sessionKey" | "storePath"
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
  const current = sessionState.sessionEntryHandle.getCurrent() ?? sessionState.sessionEntry;
  if (current.sessionId === entry.sessionId) {
    const next = {
      ...current,
      sessionDiffBaseline: entry.sessionDiffBaseline,
      sessionDiffBaselineCapture: entry.sessionDiffBaselineCapture,
    };
    sessionState.sessionEntry = next;
    sessionState.sessionEntryHandle.replaceCurrent(next);
  }
}
