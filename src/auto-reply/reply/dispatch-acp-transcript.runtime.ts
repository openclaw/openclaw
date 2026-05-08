import { resolveAcpSessionCwd } from "../../acp/runtime/session-identifiers.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
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
  /** Pre-resolved session store entry from the caller. When provided and
   * contains a sessionId, skips the `loadSessionStore` re-load so the writer
   * succeeds even when the on-disk store has not yet been flushed (e.g., for
   * spawn-child sessions whose store entry was written by a different runtime
   * path). */
  sessionStoreEntry?: AcpSessionStoreEntry;
}): Promise<void> {
  const promptText = params.promptText.trim();
  const finalText = params.finalText.trim();
  if (!promptText && !finalText) {
    return;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });

  // Use the pre-resolved entry when available and it carries a sessionId.
  // This avoids a redundant loadSessionStore call and removes the failure mode
  // where the on-disk store has no entry for the canonical sessionKey yet
  // (catalog #22: spawn-child sessions never wrote their advertised sessionFile
  // because this path always re-loaded from disk and found nothing).
  const preResolved = params.sessionStoreEntry?.entry?.sessionId
    ? params.sessionStoreEntry
    : undefined;

  const storePath =
    preResolved?.storePath ??
    resolveStorePath(params.cfg.session?.store, { agentId: sessionAgentId });
  const sessionStore = preResolved
    ? ({ [params.sessionKey]: preResolved.entry } as ReturnType<typeof loadSessionStore>)
    : loadSessionStore(storePath, { skipCache: true });
  const sessionEntry =
    preResolved?.entry ??
    resolveSessionStoreEntry({
      store: sessionStore,
      sessionKey: params.sessionKey,
    }).existing;
  const sessionId = sessionEntry?.sessionId;
  if (!sessionId) {
    throw new Error(`unknown ACP session key: ${params.sessionKey}`);
  }

  await persistAcpTurnTranscript({
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
}
