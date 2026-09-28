import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeAttachmentContentBlock } from "../../../lib/chat/message-normalizer-attachments.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { attachmentFailureReason } from "./chat-message-attachment-status.ts";

export type TranscriptAnnouncement = {
  key: string;
  text: string;
};

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];
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

function assistantGroupAnnouncementSource(
  group: MessageGroup,
  messageText: (message: unknown) => string | null = assistantMessageAnnouncementText,
): { key: string; text: string } | null {
  if (group.role.toLowerCase() !== "assistant") {
    return null;
  }
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const source = group.messages[index];
    const text = messageText(source?.message);
    if (text) {
      return { key: source?.key ?? group.key, text };
    }
  }
  return null;
}

export function latestTranscriptAnnouncement(
  items: readonly ChatRenderItem[],
): TranscriptAnnouncement | null {
  const announcement = (key: string, text: string): TranscriptAnnouncement => ({
    key,
    text: truncateUtf16Safe(text, ANNOUNCEMENT_MAX_CHARS),
  });
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
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
      const groups =
        part.kind === "group"
          ? [part]
          : part.kind === "work-group" || part.kind === "activity-run"
            ? part.groups.toReversed()
            : [];
      for (const group of groups) {
        const source = assistantGroupAnnouncementSource(group, messageText);
        if (source) {
          return announcement(source.key, source.text);
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
