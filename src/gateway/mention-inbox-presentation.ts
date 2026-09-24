import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MentionInboxItem } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { humanMentionDisplayLabel } from "./human-mention-policy.js";
import type { MentionStoreExcerpt, MentionStoreMessage } from "./mention-inbox-store.codec.js";
import { deriveSessionTitle } from "./session-utils-core.js";

/** Strip recipient routing metadata when materializing one retained display value. */
export function projectMentionExcerpt(
  excerpts: MentionStoreMessage["recipientExcerpts"],
  profileId: string,
): MentionStoreExcerpt | undefined {
  const value = excerpts?.find((entry) => entry.profileId === profileId);
  return value && { excerpt: value.excerpt, excerptMention: { ...value.excerptMention } };
}

/** Format already-authorized current display facts without retaining caller-mutable spans. */
export function projectMentionInboxItem(
  item: {
    id: string;
    source: { expiresAt: number };
    message: MentionStoreMessage;
    preview?: MentionStoreExcerpt;
  },
  current: {
    sender?: { profileId: string; label?: string; avatarUrl?: string };
    target: { entry: SessionEntry };
  },
): MentionInboxItem {
  const { content } = item.message;
  return {
    ...content,
    ...(item.preview
      ? { excerpt: item.preview.excerpt, excerptMention: { ...item.preview.excerptMention } }
      : {}),
    id: item.id,
    expiresAt: item.source.expiresAt,
    senderProfileId: current.sender?.profileId ?? content.senderProfileId,
    senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
    ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
    sessionTitle:
      truncateUtf16Safe(
        (deriveSessionTitle(current.target.entry) ?? "Conversation")
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        256,
      ) || "Conversation",
  };
}
