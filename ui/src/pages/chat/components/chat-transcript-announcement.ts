import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeAttachmentContentBlock } from "../../../lib/chat/message-normalizer-attachments.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { isSessionActivityGroup } from "../chat-turn-boundary.ts";
import { attachmentFailureReason } from "./chat-message-attachment-status.ts";

registerChatComposerEnglish();

registerChatMessageMetadataEnglish();

export type TranscriptAnnouncement = {
  key: string;
  text: string;
};

type ChatRenderItem = SystemEventRenderItem;
const ANNOUNCEMENT_MAX_CHARS = 500;

function assistantMessageAttachmentFailureText(message: unknown): string | null {
  const rawContent = asOptionalRecord(message)?.content;
  const content: unknown[] = Array.isArray(rawContent) ? rawContent : [];
  const failures = content.flatMap((item) =>
    (normalizeAttachmentContentBlock(item) ?? []).filter(
      (block) => block.type === "attachment_error",
    ),
  );
  const failureText = failures
    .map(
      ({ attachment }) =>
        `${attachment.label}: ${t("chat.attachments.notSent")}. ${attachmentFailureReason(attachment.code)}`,
    )
    .join(" ");
  return failureText || null;
}

function assistantMessageAnnouncementText(message: unknown): string | null {
  const text = extractTextCached(message)?.trim();
  const failureText = assistantMessageAttachmentFailureText(message);
  return [failureText, text].filter(Boolean).join(" ") || null;
}

export function latestTranscriptAnnouncement(
  items: readonly ChatRenderItem[],
  liveItem?: ChatRenderItem,
): TranscriptAnnouncement | null {
  const announcement = (key: string, text: string): TranscriptAnnouncement => ({
    key,
    text: truncateUtf16Safe(text, ANNOUNCEMENT_MAX_CHARS),
  });
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const base = items[itemIndex];
    const item = base?.key === liveItem?.key ? liveItem : base;
    if (!item) {
      continue;
    }
    let messageText = assistantMessageAnnouncementText;
    if (item.kind === "agent-run-frame") {
      if (item.outcome.kind === "completed") {
        const owner = item.outcome.actionOwner;
        const text = owner ? assistantMessageAnnouncementText(owner.message) : null;
        if (owner && text) {
          return announcement(owner.key, text);
        }
        messageText = assistantMessageAttachmentFailureText;
      }
      if (item.outcome.kind === "failed") {
        continue;
      }
    }
    for (const part of item.kind === "agent-run-frame" ? item.parts.toReversed() : [item]) {
      if (part.kind === "stream-run") {
        if (item.kind === "agent-run-frame" && item.outcome.kind !== "completed") {
          const text = part.parts.findLast(
            (streamPart) => streamPart.kind === "stream" && streamPart.text.trim(),
          );
          if (text?.kind === "stream") {
            return announcement(text.key, text.text.trim());
          }
        }
        continue;
      }
      for (const group of chatItemGroups(part).toReversed()) {
        if (isSessionActivityGroup(group)) {
          const count = group.messages.length;
          const source = group.senderSession?.label ?? group.senderSession?.sessionKey;
          const label = t(
            source
              ? count === 1
                ? "chat.messages.interSessionUpdateFrom"
                : "chat.messages.interSessionUpdatesFrom"
              : count === 1
                ? "chat.messages.interSessionUpdate"
                : "chat.messages.interSessionUpdates",
            { count: String(count) },
          );
          return announcement(
            group.messages.at(-1)?.key ?? group.key,
            source ? `${label} ${source}` : label,
          );
        }
        if (group.role.toLowerCase() !== "assistant") {
          continue;
        }
        for (let index = group.messages.length - 1; index >= 0; index -= 1) {
          const source = group.messages[index];
          const text = messageText(source?.message);
          if (text) {
            return announcement(source?.key ?? group.key, text);
          }
        }
      }
    }
  }
  return null;
}

export class TranscriptAnnouncementState {
  private key: string | null | undefined;
  text = "";

  sync(announcement: TranscriptAnnouncement | null, announce: boolean): void {
    if (this.key === undefined || !announce) {
      this.key = announcement?.key ?? null;
      this.text = "";
    } else if (announcement && announcement.key !== this.key) {
      this.key = announcement.key;
      this.text = announcement.text;
    }
  }
}
