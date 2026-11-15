import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  MESSAGE_LOCALE_PREFERENCE_KEY,
  resolveMessageLocale,
} from "../../shared/message-locale.js";
import { getRequesterProfile } from "../requester-profile.js";
import type { MsgContext } from "../templating.js";

/** Capture once, before queueing. A later turn or preference change cannot relabel this reply. */
export async function prepareReplyMessageLocale(
  ctx: MsgContext,
  cfg: OpenClawConfig,
): Promise<void> {
  if (ctx.MessageLocale !== undefined) {
    ctx.MessageLocale = resolveMessageLocale(ctx.MessageLocale);
    return;
  }
  const chatType = normalizeChatType(ctx.ChatType);
  const group = chatType === "group" || chatType === "channel";
  const profile = group ? undefined : getRequesterProfile(ctx);
  let personal: unknown;
  if (profile) {
    const { getCanonicalUserPreferences } = await import("../../state/user-preferences.js");
    try {
      const preferences = await getCanonicalUserPreferences(profile.id, [
        MESSAGE_LOCALE_PREFERENCE_KEY,
      ]);
      // The existing requester owner validates identity; a preference never conveys authority.
      if (profile.isCurrent()) {
        personal = preferences?.entries[MESSAGE_LOCALE_PREFERENCE_KEY];
      }
    } catch {
      createSubsystemLogger("auto-reply").warn(
        "Could not read the personal message language; using configured defaults.",
      );
    }
  }
  ctx.MessageLocale = resolveMessageLocale(
    personal,
    group ? undefined : ctx.ClientLocale,
    ctx.ChannelMessageLocale,
    cfg.messages?.locale,
  );
}
