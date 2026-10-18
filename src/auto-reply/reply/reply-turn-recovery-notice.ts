import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";

type RecoveryNotice = {
  sessionId: string;
  cycleId: string;
};

const MAX_RECOVERY_NOTICES = 1_024;
const log = createSubsystemLogger("auto-reply/reply-turn-admission");
const notices = resolveGlobalMap<string, RecoveryNotice>(
  Symbol.for("openclaw.replyRestartRecoveryNotices"),
  "close-and-restart",
);

/** A rejected turn can report its recovery path without reopening the session. */
export async function sendReplyRestartRecoveryNotice(params: {
  agentId: string;
  cfg: OpenClawConfig;
  channel?: string;
  sessionKey: string;
  storePath: string;
  deliver: (text: string) => Promise<boolean>;
}): Promise<void> {
  try {
    const currentAcpSession = await readAcpSessionEntryAsync({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    // Admission may have waited while reset or deletion changed the session.
    const entry: InternalSessionEntry | undefined = await readSessionEntryReadOnlyInWorker({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    const recovery = entry?.mainRestartRecovery;
    if (!entry || !recovery?.tombstone) {
      return;
    }
    if (
      isParentOwnedBackgroundAcpSession(
        currentAcpSession?.entry
          ? { ...currentAcpSession.entry, acp: currentAcpSession.acp }
          : undefined,
      ) ||
      resolveSendPolicy({
        cfg: params.cfg,
        entry,
        sessionKey: params.sessionKey,
        channel: params.channel,
        chatType: entry.chatType,
      }) === "deny"
    ) {
      return;
    }
    const key = JSON.stringify([params.agentId, params.storePath, params.sessionKey]);
    const previous = notices.get(key);
    if (previous?.sessionId === entry.sessionId && previous.cycleId === recovery.cycleId) {
      return;
    }
    notices.delete(key);
    pruneMapToMaxSize(notices, MAX_RECOVERY_NOTICES - 1);
    // Claim before awaiting delivery; ambiguous failures must not produce a notice storm.
    notices.set(key, {
      sessionId: entry.sessionId,
      cycleId: recovery.cycleId,
    });
    const hint =
      entry.modelSelectionLocked === true
        ? "Open it in WebChat and use Resume."
        : "Use Resume in WebChat, or /reset or /new to start a replacement session.";
    if (!(await params.deliver(`My session in this room ended during restart recovery. ${hint}`))) {
      log.warn(
        `restart recovery notice delivery was not confirmed for session ${params.sessionKey}`,
      );
    }
  } catch (error) {
    log.warn(
      `failed to deliver restart recovery notice for session ${params.sessionKey}: ${String(error)}`,
    );
  }
}
