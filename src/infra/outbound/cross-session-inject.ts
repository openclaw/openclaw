import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { DmScope } from "../../config/types.base.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound/cross-session-inject");

/**
 * Returns `true` when the dmScope setting means each DM peer gets its own
 * isolated session transcript.
 */
function isIsolatedDmScope(dmScope: DmScope | undefined): boolean {
  return (
    dmScope === "per-peer" ||
    dmScope === "per-channel-peer" ||
    dmScope === "per-account-channel-peer"
  );
}

export type CrossSessionInjectParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  /** The target peer identifier (e.g. Telegram user id). */
  targetPeerId: string;
  /** The text the agent sent to the target. */
  text?: string;
  /** Media URLs included in the outbound message. */
  mediaUrls?: string[];
};

/**
 * After the message tool delivers an outbound message, optionally inject that
 * message into the *target user's* session transcript as an assistant message.
 *
 * This is gated on:
 * 1. `session.injectOutboundToTargetSession` being `true`
 * 2. `session.dmScope` being an isolated scope (per-peer / per-channel-peer /
 *    per-account-channel-peer).
 *
 * When both conditions are met the outbound text (or media summary) is appended
 * to the recipient's existing session file so the agent "remembers" what it said
 * the next time the recipient replies.
 */
export async function maybeCrossSessionInject(
  params: CrossSessionInjectParams,
): Promise<{ injected: boolean; reason?: string }> {
  const { cfg, channel, agentId, accountId, targetPeerId, text, mediaUrls } = params;

  if (!cfg.session?.injectOutboundToTargetSession) {
    return { injected: false, reason: "disabled" };
  }

  const dmScope = cfg.session?.dmScope;
  if (!isIsolatedDmScope(dmScope)) {
    return { injected: false, reason: "dmScope-not-isolated" };
  }

  if (!targetPeerId.trim()) {
    return { injected: false, reason: "missing-target-peer" };
  }

  const targetSessionKey = buildAgentPeerSessionKey({
    agentId,
    channel,
    accountId,
    peerId: targetPeerId,
    peerKind: "direct",
    dmScope,
  });

  try {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey: targetSessionKey,
      text,
      mediaUrls,
    });

    if (result.ok) {
      log.debug("injected outbound message into target session", {
        channel,
        targetSessionKey,
      });
      return { injected: true };
    }

    log.debug("cross-session inject skipped", {
      channel,
      targetSessionKey,
      reason: result.reason,
    });
    return { injected: false, reason: result.reason };
  } catch (err) {
    log.warn("cross-session inject failed", {
      channel,
      targetSessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { injected: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
