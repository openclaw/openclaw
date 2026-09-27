import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  parseAssistantTextSignature,
  readAssistantTextBlocksForPhase,
} from "../shared/chat-message-content.js";
import { isToolHistoryBlockType } from "./chat-display-projection.canvas.js";
import {
  isAssistantTextContentType,
  truncateChatHistoryText,
} from "./chat-display-projection.helpers.js";

export function projectAssistantCommentaryFallbacks(
  message: unknown,
  maxChars: number,
): { fallbacks: unknown[]; message: unknown } {
  if (!message || typeof message !== "object") {
    return { fallbacks: [], message };
  }
  const entry = readRecord(message);
  if (
    !entry ||
    entry.role !== "assistant" ||
    !Array.isArray(entry.content) ||
    entry.stopReason === "error" ||
    typeof entry.errorMessage === "string"
  ) {
    return { fallbacks: [], message };
  }
  const transcriptMeta = readRecord(entry["__openclaw"]);
  const commentaryBlocks = new Set<unknown>(readAssistantTextBlocksForPhase(entry, "commentary"));
  const transcriptId =
    typeof transcriptMeta?.id === "string"
      ? transcriptMeta.id.trim()
      : typeof entry.id === "string"
        ? entry.id.trim()
        : undefined;
  const groups: Array<{
    itemId: string;
    providerKeyed: boolean;
    content: Record<string, unknown>[];
    text: string[];
    sourceBlocks: unknown[];
  }> = [];
  const commentaryContent = new Set<unknown>();
  let projectedUnphasedText = false;
  let group: (typeof groups)[number] | undefined;
  for (const block of entry.content) {
    const content = readRecord(block);
    if (!content) {
      continue;
    }
    if (!isAssistantTextContentType(content.type)) {
      if (
        group &&
        ["image", "audio", "video", "attachment", "attachment_error"].includes(String(content.type))
      ) {
        group.content.push(content);
        group.sourceBlocks.push(block);
      }
      continue;
    }
    const signature = parseAssistantTextSignature(content);
    const text = typeof content.text === "string" ? content.text : "";
    const providerItemId = signature?.id?.trim();
    const itemId = providerItemId || transcriptId;
    if (!commentaryBlocks.has(block) || !itemId) {
      group = undefined;
      continue;
    }
    if (group?.itemId !== itemId) {
      group = {
        itemId,
        providerKeyed: Boolean(providerItemId),
        content: [],
        text: [],
        sourceBlocks: [],
      };
      groups.push(group);
    }
    group.providerKeyed ||= Boolean(providerItemId);
    if (signature?.phase !== "commentary") {
      group.sourceBlocks.push(block);
    }
    if (text.trim()) {
      group.content.push({ type: "text", text });
      group.text.push(text);
    }
  }
  const fallbacks = groups.flatMap(({ itemId, providerKeyed, content, text, sourceBlocks }) => {
    const hasMedia = content.some((block) => block.type !== "text");
    if (content.length === 0 || (!providerKeyed && !hasMedia)) {
      return [];
    }
    for (const block of sourceBlocks) {
      commentaryContent.add(block);
      projectedUnphasedText ||= isAssistantTextContentType(readRecord(block)?.type);
    }
    const projected = truncateChatHistoryText(text.join("\n"), maxChars);
    const projectedMeta = projected.truncated
      ? {
          ...transcriptMeta,
          truncated: true,
          reason:
            typeof transcriptMeta?.reason === "string" ? transcriptMeta.reason : "display-cap",
        }
      : transcriptMeta
        ? { ...transcriptMeta }
        : undefined;
    return [
      {
        role: "assistant",
        content,
        ...(typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {}),
        openclawStreamFallback: {
          replacementText: projected.text,
          source: "segment",
          itemId,
        },
        ...(projectedMeta ? { __openclaw: projectedMeta } : {}),
      },
    ];
  });
  if (commentaryContent.size === 0) {
    return { fallbacks, message };
  }
  const remaining: Record<string, unknown> = {
    ...entry,
    content: entry.content.filter((block) => !commentaryContent.has(block)),
  };
  if (
    projectedUnphasedText &&
    Array.isArray(remaining.content) &&
    remaining.content.some((block) => isToolHistoryBlockType(readRecord(block)?.type))
  ) {
    remaining.content = remaining.content.filter((block) => !commentaryBlocks.has(block));
    delete remaining.phase;
  }
  return { fallbacks, message: remaining };
}
