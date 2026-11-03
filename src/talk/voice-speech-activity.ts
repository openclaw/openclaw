// Activity timestamp for finalized user speech, kept apart from the voice session writer.
import { resolveSessionEntryResetFreshnessAsync } from "../config/sessions/entry-freshness.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../config/sessions/reset.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";

/**
 * Finalized user speech counts as activity, except once the chat's idle limit has passed: then
 * the activity time stays put so the next reset-capable turn applies the overdue idle reset
 * (#191629). Uses the chat's own policy and lifecycle times; a daily boundary never reads them.
 */
export async function speechActivityPatch(
  speech: { role: string; config?: OpenClawConfig },
  scope: SessionAccessScope,
): Promise<{ lastInteractionAt: number } | undefined> {
  if (speech.role !== "user") {
    return undefined;
  }
  return speech.config && (await hasExpiredIdle(speech.config, scope))
    ? undefined
    : { lastInteractionAt: Date.now() };
}

async function hasExpiredIdle(cfg: OpenClawConfig, scope: SessionAccessScope): Promise<boolean> {
  const now = Date.now();
  let read: Awaited<ReturnType<typeof resolveSessionEntryResetFreshnessAsync>>;
  try {
    read = await resolveSessionEntryResetFreshnessAsync({
      ...scope,
      storePath: scope.storePath || undefined,
      now,
      sessionCfg: cfg.session,
      resetType: resolveSessionResetType({ sessionKey: scope.sessionKey }),
      // Talk speech and its typed follow-ups enter through Gateway clients, which chat.send
      // resolves as WebChat, whatever external route the conversation also has.
      resetOverride: resolveChannelResetConfig({
        sessionCfg: cfg.session,
        channel: INTERNAL_MESSAGE_CHANNEL,
      }),
    });
  } catch (error) {
    // Unknown expiry must not hide an overdue reset: keep the activity time, still save the speech.
    console.warn(`[talk] voice idle expiry check failed: ${String(error)}`);
    return true;
  }
  const { state, freshness } = read;
  return (
    state === "stale" && freshness.idleExpiresAt !== undefined && now > freshness.idleExpiresAt
  );
}
