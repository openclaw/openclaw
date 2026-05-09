import { parseSqliteSessionTranscriptLocator } from "./paths.js";
import { appendSqliteSessionTranscriptMessage as appendSqliteSessionTranscriptMessageAtomically } from "./transcript-store.sqlite.js";

async function loadCurrentSessionVersion(): Promise<number> {
  return (await import("../../agents/transcript/session-transcript-contract.js"))
    .CURRENT_SESSION_VERSION;
}

function normalizeRequiredScope(params: {
  transcriptLocator?: string;
  agentId?: string;
  sessionId?: string;
}): { agentId: string; sessionId: string } {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId) {
    throw new Error("SQLite transcript appends require agentId and sessionId.");
  }
  const locator = params.transcriptLocator?.trim()
    ? parseSqliteSessionTranscriptLocator(params.transcriptLocator)
    : undefined;
  if (params.transcriptLocator?.trim() && !locator) {
    throw new Error("SQLite transcript appends require a SQLite transcript locator.");
  }
  if (locator && (locator.agentId !== agentId || locator.sessionId !== sessionId)) {
    throw new Error("SQLite transcript locator does not match the append scope.");
  }
  return {
    agentId,
    sessionId,
  };
}

export async function appendSessionTranscriptMessage(params: {
  transcriptLocator?: string;
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
    cwd: params.cwd,
    message: params.message,
    now: () => params.now ?? Date.now(),
  });
}
