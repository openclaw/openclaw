import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSecrets } from "../../logging/redact.js";
import { appendSqliteSessionTranscriptMessage as appendSqliteSessionTranscriptMessageAtomically } from "./transcript-store.sqlite.js";

async function loadCurrentSessionVersion(): Promise<number> {
  return (await import("../../agents/transcript/session-transcript-contract.js"))
    .CURRENT_SESSION_VERSION;
}

function normalizeRequiredScope(params: { agentId?: string; sessionId?: string }): {
  agentId: string;
  sessionId: string;
} {
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
  dedupeLatestAssistantText?: string;
  message: unknown;
  agentId: string;
  now?: number;
  sessionId: string;
  cwd?: string;
  config?: OpenClawConfig;
}): Promise<{ messageId: string; message: unknown }> {
  const scope = normalizeRequiredScope(params);
  const sessionVersion = await loadCurrentSessionVersion();
  const message = isTranscriptAgentMessage(params.message)
    ? redactTranscriptMessage(params.message, params.config)
    : redactSecrets(params.message);
  const { messageId } = appendSqliteSessionTranscriptMessageAtomically({
    agentId: scope.agentId,
    ...(params.dedupeLatestAssistantText
      ? { dedupeLatestAssistantText: params.dedupeLatestAssistantText }
      : {}),
    sessionId: scope.sessionId,
    sessionVersion,
    cwd: params.cwd,
    message,
    now: () => params.now ?? Date.now(),
  });
  return { messageId, message };
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}
