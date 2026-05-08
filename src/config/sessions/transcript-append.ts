import path from "node:path";
import { appendSqliteSessionTranscriptMessage as appendSqliteSessionTranscriptMessageAtomically } from "./transcript-store.sqlite.js";

async function loadCurrentSessionVersion(): Promise<number> {
  return (await import("../../agents/transcript/session-transcript-contract.js"))
    .CURRENT_SESSION_VERSION;
}

function normalizeRequiredScope(params: {
  transcriptPath?: string;
  agentId?: string;
  sessionId?: string;
}): { agentId: string; sessionId: string } {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId) {
    throw new Error("SQLite transcript appends require agentId and sessionId.");
  }
  return {
    agentId,
    sessionId,
  };
}

export async function appendSessionTranscriptMessage(params: {
  transcriptPath?: string;
  message: unknown;
  agentId?: string;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: unknown;
}): Promise<{ messageId: string }> {
  const scope = normalizeRequiredScope(params);
  const sessionVersion = await loadCurrentSessionVersion();
  return appendSqliteSessionTranscriptMessageAtomically({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    sessionVersion,
    ...(params.transcriptPath ? { transcriptPath: path.resolve(params.transcriptPath) } : {}),
    cwd: params.cwd,
    message: params.message,
    now: () => params.now ?? Date.now(),
  });
}
