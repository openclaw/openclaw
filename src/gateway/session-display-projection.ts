import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isHeartbeatOkResponse } from "../auto-reply/heartbeat-filter.js";
import type { SessionPreviewItem } from "../config/sessions/session-history-read.types.js";
import { projectAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { stripEnvelope } from "../shared/chat-envelope.js";
import {
  extractAssistantPhaseText,
  isSilentAssistantTranscriptMessage,
} from "../shared/chat-message-content.js";
import {
  asRoleContentMessage,
  isProjectedForwardedMessage,
  stripAssistantMediaDirectivesForDisplay,
  takeAssistantManagedMediaUrlsForDisplay,
} from "./chat-display-projection.helpers.js";
import { prepareAssistantHistoryMessage } from "./chat-display-projection.sanitize.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;
const SESSION_DISPLAY_PROJECTION_MAX_CHARS = 800;

type SessionDisplayProjectionOptions = {
  flattenMarkdown?: boolean;
  view?: "display" | "model-context";
  maxChars?: number;
};

function extractUserText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content.flatMap((block) => {
      const entry = readRecord(block);
      if (!entry) {
        return [];
      }
      return (entry.type === "text" || entry.type === "input_text") &&
        typeof entry.text === "string"
        ? [entry.text]
        : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return typeof message.text === "string" ? message.text : undefined;
}

/** Projects text after model-context selection, or applies ordinary display visibility. */
export function projectSessionDisplayMessage(
  message: unknown,
  options: SessionDisplayProjectionOptions = {},
): {
  role: "user" | "assistant";
  text: string;
} | null {
  const entry = readRecord(prepareAssistantHistoryMessage(message));
  if (!entry || (options.view !== "model-context" && entry.display === false)) {
    return null;
  }
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if ((role !== "user" && role !== "assistant") || isSilentAssistantTranscriptMessage(entry)) {
    return null;
  }
  const projectedEntry =
    role === "assistant" && options.view !== "model-context"
      ? projectAssistantDisplayContent({ ...entry, role })
      : entry;
  const extracted =
    role === "assistant" ? extractAssistantPhaseText(projectedEntry) : extractUserText(entry);
  let text = extracted;
  if (text && role === "assistant" && options.view !== "model-context") {
    const roleContent = asRoleContentMessage(projectedEntry);
    if (
      roleContent &&
      !isProjectedForwardedMessage(roleContent) &&
      isHeartbeatOkResponse(roleContent)
    ) {
      return null;
    }
    text = stripAssistantMediaDirectivesForDisplay(
      text,
      takeAssistantManagedMediaUrlsForDisplay(projectedEntry, role).urls,
    );
  }
  text = text?.trim();
  if (!text) {
    return null;
  }
  if (role === "user") {
    text = stripEnvelope(text).trim();
  }
  if (options.flattenMarkdown) {
    text = flattenMarkdownToPlainText(text);
  }
  if (!text) {
    return null;
  }
  const requestedMaxChars = options.maxChars ?? SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS;
  const limit = Math.min(
    SESSION_DISPLAY_PROJECTION_MAX_CHARS,
    Math.max(20, Math.floor(requestedMaxChars)),
  );
  return {
    role,
    text: text.length <= limit ? text : `${truncateUtf16Safe(text, limit - 3)}...`,
  };
}

export function buildSessionPreviewItems(
  messages: readonly unknown[],
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  // Rejected rows do not consume the limit; older text cannot affect a full preview.
  for (let index = messages.length - 1; index >= 0 && items.length < maxItems; index -= 1) {
    const projected = projectSessionDisplayMessage(messages[index], { maxChars, view });
    if (!projected) {
      continue;
    }
    items.push(projected);
  }

  return items.toReversed();
}
