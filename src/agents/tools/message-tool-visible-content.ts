import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  hasInboundMetadataSentinel,
  stripInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import {
  getBootEchoContextForSession,
  stripBootEchoFromOutboundText,
} from "../../gateway/boot-echo-guard.js";
import {
  parseInteractiveParam,
  parseJsonMessageParam,
} from "../../infra/outbound/message-action-params.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";
import { readStringArrayParam, readToolStringParam } from "./common.js";
export function normalizeEscapedLineBreaksForVisibleText(text: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  // The send path turns literal "\n" sequences into line breaks later; match
  // that before privacy stripping so escaped delimiter lines cannot bypass it.
  return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

export type VisibleTextSuppressionReason =
  | "internal_runtime_context_echo"
  | "inbound_metadata_echo"
  | "poll_vote_echo";

function sanitizeUserVisibleToolTextResult(
  text: string,
  bootPrompt: string | undefined,
): {
  text: string;
  suppressionReason?: VisibleTextSuppressionReason;
} {
  const normalized = normalizeEscapedLineBreaksForVisibleText(text);
  const strippedReasoning = stripFormattedReasoningMessage(normalized);
  const strippedInternal = stripInternalRuntimeContext(strippedReasoning);
  const strippedBoot = stripBootEchoFromOutboundText(strippedInternal, bootPrompt);
  const strippedInbound = hasInboundMetadataSentinel(strippedBoot)
    ? stripInboundMetadata(strippedBoot)
    : strippedBoot;
  const suppressionReason =
    strippedBoot.trim().length === 0 &&
    strippedReasoning.trim().length > 0 &&
    (strippedInternal !== strippedReasoning || strippedBoot !== strippedInternal)
      ? "internal_runtime_context_echo"
      : strippedInbound.trim().length === 0 &&
          strippedBoot.trim().length > 0 &&
          strippedInbound !== strippedBoot
        ? "inbound_metadata_echo"
        : undefined;
  return {
    text: strippedInbound,
    ...(suppressionReason ? { suppressionReason } : {}),
  };
}

function sanitizePresentationTextFields(
  value: unknown,
  sanitizeText: (text: string, trim?: boolean) => string,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const sanitizeFields = (record: Record<string, unknown>, fields: string[], trim = false) => {
    for (const field of fields) {
      if (typeof record[field] === "string") {
        record[field] = sanitizeText(record[field], trim);
      }
    }
  };
  const sanitizeStrings = (entries: unknown[], trim = false) =>
    entries.map((entry) => (typeof entry === "string" ? sanitizeText(entry, trim) : entry));
  const sanitizeRecordArray = (entries: unknown[], field: "label" | "name") =>
    entries.map((entry) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const sanitized = { ...entry };
      sanitizeFields(sanitized, [field]);
      return sanitized;
    });
  const presentation = { ...value };
  sanitizeFields(presentation, ["title"]);
  if (Array.isArray(presentation.blocks)) {
    presentation.blocks = presentation.blocks.map((block) => {
      if (!isRecord(block)) {
        return block;
      }
      const sanitizedBlock = { ...block };
      sanitizeFields(sanitizedBlock, ["text", "placeholder", "title", "xLabel", "yLabel"]);
      if (normalizeOptionalLowercaseString(sanitizedBlock.type) === "table") {
        sanitizeFields(sanitizedBlock, ["caption"], true);
        if (Array.isArray(sanitizedBlock.headers)) {
          sanitizedBlock.headers = sanitizeStrings(sanitizedBlock.headers, true);
        }
        if (Array.isArray(sanitizedBlock.rows)) {
          sanitizedBlock.rows = sanitizedBlock.rows.map((row) =>
            Array.isArray(row) ? sanitizeStrings(row, true) : row,
          );
        }
      }
      if (Array.isArray(sanitizedBlock.buttons)) {
        sanitizedBlock.buttons = sanitizedBlock.buttons.map((button) => {
          if (!isRecord(button)) {
            return button;
          }
          const sanitizedButton = { ...button };
          sanitizeFields(sanitizedButton, ["label"]);
          if (typeof sanitizedButton.url === "string") {
            const url = sanitizeText(sanitizedButton.url);
            if (url) {
              sanitizedButton.url = url;
            } else {
              delete sanitizedButton.url;
            }
          }
          for (const webAppField of ["webApp", "web_app"]) {
            const webApp = sanitizedButton[webAppField];
            if (!isRecord(webApp)) {
              continue;
            }
            const sanitizedWebApp = { ...webApp };
            if (typeof sanitizedWebApp.url !== "string") {
              continue;
            }
            const url = sanitizeText(sanitizedWebApp.url);
            if (url) {
              sanitizedWebApp.url = url;
              sanitizedButton[webAppField] = sanitizedWebApp;
            } else {
              delete sanitizedButton[webAppField];
            }
          }
          const action = sanitizedButton.action;
          if (isRecord(action)) {
            const sanitizedAction = { ...action };
            if (
              (sanitizedAction.type === "url" || sanitizedAction.type === "web-app") &&
              typeof sanitizedAction.url === "string"
            ) {
              const url = sanitizeText(sanitizedAction.url);
              if (url) {
                sanitizedAction.url = url;
                sanitizedButton.action = sanitizedAction;
              } else if (
                sanitizedAction.type === "web-app" &&
                typeof sanitizedAction.widgetId === "string" &&
                sanitizedAction.widgetId.trim()
              ) {
                delete sanitizedAction.url;
                sanitizedButton.action = sanitizedAction;
              } else {
                // Explicit typed actions own the control. If sanitization removes
                // the target, legacy shadow fields must not become active fallbacks.
                delete sanitizedButton.action;
                delete sanitizedButton.value;
                delete sanitizedButton.url;
                delete sanitizedButton.webApp;
                delete sanitizedButton.web_app;
              }
            }
          }
          return sanitizedButton;
        });
      }
      if (Array.isArray(sanitizedBlock.options)) {
        sanitizedBlock.options = sanitizeRecordArray(sanitizedBlock.options, "label");
      }
      if (Array.isArray(sanitizedBlock.categories)) {
        sanitizedBlock.categories = sanitizeStrings(sanitizedBlock.categories);
      }
      if (Array.isArray(sanitizedBlock.segments)) {
        sanitizedBlock.segments = sanitizeRecordArray(sanitizedBlock.segments, "label");
      }
      if (Array.isArray(sanitizedBlock.series)) {
        sanitizedBlock.series = sanitizeRecordArray(sanitizedBlock.series, "name");
      }
      return sanitizedBlock;
    });
  }
  return presentation;
}

function readFirstStringParam(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readToolStringParam(params, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function readStructuredAttachmentMediaParam(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let media: string | undefined;
  for (const attachment of value) {
    if (!isRecord(attachment)) {
      continue;
    }
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      // Preserve eager alias reads; earlier content must not hide a later accessor error.
      media = readToolStringParam(attachment, key) || media;
    }
  }
  return media;
}

export function hasSanitizedSendPayloadContent(params: Record<string, unknown>): boolean {
  let text: string | undefined;
  for (const field of ["message", "text", "content", "caption", "SendMessage"]) {
    const value = typeof params[field] === "string" ? params[field] : "";
    if (value.trim()) {
      text = value;
    }
  }
  const mediaUrls = readStringArrayParam(params, "mediaUrls");
  const attachmentMedia = readStructuredAttachmentMediaParam(params.attachments);
  const hasPayload = hasReplyPayloadContent({
    text,
    mediaUrl:
      readFirstStringParam(params, ["media", "mediaUrl", "path", "filePath", "fileUrl"]) ||
      attachmentMedia,
    mediaUrls,
    presentation: params.presentation,
    interactive: params.interactive,
    location: params.location,
  });
  // Inline buffers are staged by the outbound media owner after sanitization.
  return hasPayload || Boolean(readToolStringParam(params, "buffer"));
}

export function sanitizeMessageToolVisiblePayload(
  params: Record<string, unknown>,
  agentSessionKey?: string,
): VisibleTextSuppressionReason | undefined {
  const bootPromptForSession = getBootEchoContextForSession(agentSessionKey);
  let suppressedVisiblePayloadReason: VisibleTextSuppressionReason | undefined;
  const sanitizeText = (text: string, trim = false) => {
    const sanitized = sanitizeUserVisibleToolTextResult(text, bootPromptForSession);
    // Keep sanitizing after suppression; the first reason only labels the outcome.
    suppressedVisiblePayloadReason ??= sanitized.suppressionReason;
    return trim ? sanitized.text.trim() : sanitized.text;
  };
  parseJsonMessageParam(params, "presentation");
  parseInteractiveParam(params);
  for (const field of [
    "text",
    "content",
    "message",
    "caption",
    "SendMessage",
    "quoteText",
    "quote_text",
    "pollQuestion",
    "poll_question",
  ]) {
    if (typeof params[field] === "string") {
      params[field] = sanitizeText(params[field]);
    }
  }
  for (const field of ["pollOption", "poll_option"]) {
    const value = params[field];
    if (typeof value === "string") {
      params[field] = sanitizeText(value);
    } else if (Array.isArray(value)) {
      params[field] = value.map((entry) =>
        typeof entry === "string" ? sanitizeText(entry) : entry,
      );
    }
  }
  for (const field of ["presentation", "interactive"]) {
    params[field] = sanitizePresentationTextFields(params[field], sanitizeText);
  }
  return suppressedVisiblePayloadReason;
}
