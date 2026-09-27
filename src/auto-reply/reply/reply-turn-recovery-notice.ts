import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { loadSessionStoreEntry } from "./dispatch-from-config.runtime.js";

type RecoveryNotice = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  cycleId: string;
};

const MAX_RECOVERY_NOTICES = 1_024;
const log = createSubsystemLogger("auto-reply/reply-turn-admission");
const notices = resolveGlobalSingleton<{
  entries: Map<string, RecoveryNotice>;
  unsubscribe?: () => void;
}>(
  Symbol.for("openclaw.replyRestartRecoveryNotices"),
  () => ({
    entries: new Map<string, RecoveryNotice>(),
  }),
  (state) => {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.entries.clear();
  },
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
    // Admission may have waited while reset or deletion changed the session.
    const entry: InternalSessionEntry | undefined = loadSessionStoreEntry({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    const recovery = entry?.mainRestartRecovery;
    if (!entry || !recovery?.tombstone) {
      return;
    }
    const currentAcpSession = readAcpSessionEntry({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
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
    notices.unsubscribe ??= onSessionIdentityMutation((mutation) => {
      const keys = new Set([
        ...mutation.previous.sessionKeys,
        ...(mutation.kind === "delete" ? [] : mutation.current.sessionKeys),
      ]);
      for (const [key, notice] of notices.entries) {
        if (notice.agentId === mutation.agentId && keys.has(notice.sessionKey)) {
          notices.entries.delete(key);
        }
      }
    });
    const key = JSON.stringify([params.agentId, params.storePath, params.sessionKey]);
    const previous = notices.entries.get(key);
    if (previous?.sessionId === entry.sessionId && previous.cycleId === recovery.cycleId) {
      return;
    }
    notices.entries.delete(key);
    if (notices.entries.size >= MAX_RECOVERY_NOTICES) {
      const oldestKey = notices.entries.keys().next().value;
      if (oldestKey !== undefined) {
        notices.entries.delete(oldestKey);
      }
    }
    // Claim before awaiting delivery; ambiguous failures must not produce a notice storm.
    notices.entries.set(key, {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
      cycleId: recovery.cycleId,
    });
    const hint =
      entry.modelSelectionLocked === true
        ? "Open it in WebChat and use Resume in new session."
        : "Use /reset or /new to start a replacement session.";
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
