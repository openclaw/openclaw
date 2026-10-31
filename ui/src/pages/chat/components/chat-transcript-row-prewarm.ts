import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { isToolCallContentType } from "../../../../../src/chat/tool-content.js";
import { parseMarkdownJson } from "../../../components/markdown-json.ts";
import {
  prewarmSanitizedMarkdown,
  type MarkdownPrewarmMode,
} from "../../../components/markdown.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { resolveCappedMessageId } from "../chat-message-recovery.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { messageMarkdownRenderOptions } from "./chat-message-bubble-presentation.ts";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { prepareMarkdownMediaSource } from "./chat-message-media-markdown.ts";
import { projectMessageMedia } from "./chat-message-media.ts";
import type { TranscriptContent, TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";

/** Warm settled text only; media resources and recovered messages keep their visible lifecycle. */
export function prewarmGroupedMessage(
  message: unknown,
  opts: Pick<GroupedMessageOptions, "onOpenImage" | "fetchLinkFavicon">,
  mode: MarkdownPrewarmMode = "cold-fragment",
): boolean {
  const role = asNullableRecord(message)?.role;
  if ((role !== "user" && role !== "assistant") || resolveCappedMessageId(message, role)) {
    return false;
  }
  const prepared = prepareChatMessageRender(message);
  // Media text uses the same slots as the visible renderer, without mounting resources.
  if (
    prepared.normalizedMessage.content.some(
      (part) =>
        part.type !== "text" &&
        part.type !== "thinking" &&
        part.type !== "image" &&
        part.type !== "canvas" &&
        !isToolCallContentType(part.type),
    )
  ) {
    return false;
  }
  const ordered =
    role === "assistant" &&
    Boolean(prepared.displayMarkdown) &&
    prepared.normalizedMessage.content.some((part) => part.type === "image");
  const markdown = ordered
    ? resolveMessageDisplayMarkdown(message, {
        ...prepared.normalizedMessage,
        content: [
          {
            type: "text",
            text: prepareMarkdownMediaSource(
              projectMessageMedia(message, prepared.normalizedMessage.content).orderedContent,
            ).markdown,
          },
        ],
      })
    : prepared.displayMarkdown;
  return (
    Boolean(markdown) &&
    !parseMarkdownJson(markdown) &&
    prewarmSanitizedMarkdown(
      markdown,
      messageMarkdownRenderOptions(role, prepared, prepared.displayMarkdown, {
        ...opts,
        isStreaming: false,
      }),
      mode,
    )
  );
}

/** Each retained renderer owns its preparation cursor without retaining evicted rows. */
export function createTranscriptRowPrewarmer() {
  const prewarming = new WeakMap<TranscriptRow, { mode: MarkdownPrewarmMode; next: number }>();
  return (row: TranscriptRow, content: TranscriptContent, mode: MarkdownPrewarmMode): boolean => {
    let progress = prewarming.get(row);
    if (!progress || progress.mode !== mode) {
      progress = { mode, next: 0 };
      prewarming.set(row, progress);
    }
    const view = content instanceof GuardedTranscriptItem ? content.native : undefined;
    // Restoring every source in an atomic row larger than the fragment cache
    // would evict its own earlier work forever. Restore a bounded prefix of
    // eight sources; the shared cache still caps all rows at 256 fragments.
    let position = 0;
    const prewarm = (
      message: unknown,
      options: Pick<GroupedMessageOptions, "onOpenImage" | "fetchLinkFavicon">,
    ) => {
      const currentMode = mode === "fragment" && position >= 8 ? "cold-fragment" : mode;
      if (position++ < progress.next) {
        return false;
      }
      // Finish this pass even if a large row evicts its earlier HTML entries.
      progress.next = position;
      return prewarmGroupedMessage(message, options, currentMode);
    };
    if (view?.kind === "group" && !view.group.isStreaming) {
      for (const message of view.group.messages) {
        if (prewarm(message.message, view.options)) {
          return true;
        }
      }
    } else if (view?.kind === "frame" && view.frame.outcome.kind === "completed") {
      // Only this fragment's visible groups participate; collapsed work stays cold.
      // Admit one message per callback so a whole run cannot consume the slice.
      for (const part of view.frame.parts) {
        if (part.kind !== "group" || part.isStreaming) {
          continue;
        }
        const options = view.options.renderGroupOptions(part);
        for (const message of part.messages) {
          if (prewarm(message.message, options)) {
            return true;
          }
        }
      }
    }
    prewarming.delete(row);
    return false;
  };
}
