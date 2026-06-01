// Bridges ACP transcript events into persisted OpenClaw session transcripts.
import { resolveAcpSessionCwd } from "@openclaw/acp-core/runtime/session-identifiers";
import type { AcpTurnSaveHookResult } from "../../acp/control-plane/manager.types.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { persistAcpTurnTranscript } from "../../agents/command/attempt-execution.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../../config/sessions.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function persistAcpDispatchTranscript(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  promptText: string;
  finalText: string;
  meta?: SessionAcpMeta;
  threadId?: string | number;
}): Promise<AcpTurnSaveHookResult> {
  const promptText = params.promptText.trim();
  const finalText = params.finalText.trim();
  if (!promptText && !finalText) {
    return { saveOutcome: "skipped", saveSkipReason: "empty_turn" };
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: sessionAgentId,
  });
  const sessionStore = loadSessionStore(storePath, { skipCache: true });
  const sessionEntry = resolveSessionStoreEntry({
    store: sessionStore,
    sessionKey: params.sessionKey,
  }).existing;
  const sessionId = sessionEntry?.sessionId;
  if (!sessionId) {
    throw new Error(`unknown ACP session key: ${params.sessionKey}`);
  }

  const persistResult = await persistAcpTurnTranscript({
    body: promptText,
    transcriptBody: promptText,
    finalText,
    sessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    sessionAgentId,
    threadId: params.threadId,
    sessionCwd: resolveAcpSessionCwd(params.meta) ?? process.cwd(),
    config: params.cfg,
  });
  return persistResult.saveOutcome === "saved"
    ? { saveOutcome: "saved" }
    : {
        saveOutcome: "skipped",
        saveSkipReason: persistResult.saveSkipReason ?? "no_transcript_write",
      };
}
