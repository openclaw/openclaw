import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  copyPreparedModelVisibleToolText,
  isPreparedModelVisibleToolText,
} from "../logging/redact-internal.js";
import { redactSourceInputTextWithConfig } from "../logging/redact-source.js";
import { readNestedToolActivity } from "../sessions/nested-tool-activity.js";
import type { AgentMessage } from "./runtime/index.js";
import {
  copyCodeModeSourceAppend,
  readCodeModeSourceFields,
  type CodeModeSourceAppend,
} from "./transcript-code-mode-source.js";
import {
  sanitizeTranscriptImageDataUrlField,
  sanitizeTranscriptImageRecord,
  shouldPreserveNestedTranscriptImageDataUrlFields,
} from "./transcript-redact-images.js";
import {
  isPlainTranscriptObject,
  resolveTranscriptAssistantRoute,
  sanitizeAssistantReplayField,
  sanitizeCompactionReplayState,
  type TranscriptAssistantRoute,
} from "./transcript-redact-replay.js";
import {
  redactTranscriptStructuredFieldValue,
  redactTranscriptText,
  resolveTranscriptLoggingConfig,
} from "./transcript-redact-text.js";

export { sanitizeOpenAIReasoningSignature } from "./transcript-redact-replay.js";

type TranscriptValueLocation =
  | "root"
  | "assistant-content-array"
  | "assistant-content-block"
  | "nested-tool-details"
  | "nested";

function redactTranscriptStructuredValue(
  root: unknown,
  cfg?: OpenClawConfig,
  rootLocation: TranscriptValueLocation = "nested",
  sourceSlots?: ReadonlyMap<object, ReadonlyMap<string, string>>,
): unknown {
  const seen = new WeakSet<object>();
  const redactValue = (
    value: unknown,
    fieldKey?: string,
    preserveImageDataUrlFields = false,
    location: TranscriptValueLocation = "nested",
    assistantRoute?: TranscriptAssistantRoute,
    modelVisibleToolResult = false,
    sourceFields?: ReadonlyMap<string, string>,
  ): unknown => {
    if (typeof value === "string") {
      if (fieldKey) {
        return redactTranscriptStructuredFieldValue(fieldKey, value, cfg, modelVisibleToolResult);
      }
      return redactTranscriptText(value, cfg, modelVisibleToolResult);
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      let changed = false;
      const redacted = value.map((item) => {
        const next = redactValue(
          item,
          fieldKey,
          preserveImageDataUrlFields,
          location === "assistant-content-array" ? "assistant-content-block" : "nested",
          assistantRoute,
          modelVisibleToolResult,
        );
        changed ||= next !== item;
        return next;
      });
      seen.delete(value);
      return changed ? redacted : value;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      // Avoid recursive transcript payloads from escaping redaction or crashing
      // persistence; circular refs serialize as a stable marker.
      return "[Circular]";
    }
    if (!isPlainTranscriptObject(value)) {
      // Non-plain instances can carry runtime state; leave them untouched instead
      // of cloning unexpected prototypes into transcripts.
      return value;
    }

    seen.add(value);
    const sanitizedImageRecord = sanitizeTranscriptImageRecord(value);
    const source = sanitizedImageRecord ?? value;
    const currentAssistantRoute =
      location === "root" && source.role === "assistant"
        ? resolveTranscriptAssistantRoute(source, cfg)
        : assistantRoute;
    let next: Record<string, unknown> | null = null;
    if (source !== value) {
      next = { ...source };
    }
    for (const [key, item] of Object.entries(source)) {
      // Reuse admitted live text; custom patterns need not be idempotent.
      if (
        modelVisibleToolResult &&
        key === "text" &&
        typeof item === "string" &&
        isPreparedModelVisibleToolText(source, item, resolveTranscriptLoggingConfig(cfg))
      ) {
        continue;
      }
      // The append transaction owns this control-plane identity. Redacting it would
      // make stored dedupe disagree with the admitted message identity.
      if (location === "root" && key === "idempotencyKey") {
        continue;
      }
      // Correlation keys must match live events; nested payload lookalikes are still redacted.
      if (
        typeof item === "string" &&
        ((location === "root" && source.role === "toolResult" && key === "toolCallId") ||
          (location === "assistant-content-block" && source.type === "toolCall" && key === "id") ||
          (location === "nested-tool-details" &&
            (key === "toolCallId" ||
              key === "parentToolCallId" ||
              key === "runId" ||
              key === "scopeId" ||
              key === "afterEntryId")))
      ) {
        continue;
      }
      if (location === "root" && source.role === "assistant" && key === "providerReplay") {
        const sanitizedReplay = sanitizeCompactionReplayState(
          item,
          currentAssistantRoute,
          cfg,
          redactTranscriptStructuredValue,
        );
        if (sanitizedReplay !== undefined) {
          if (sanitizedReplay !== item) {
            next ??= { ...source };
            next[key] = sanitizedReplay;
          }
          continue;
        }
        next ??= { ...source };
        delete next[key];
        continue;
      }
      if (location === "assistant-content-block") {
        const sanitizedReplayField = sanitizeAssistantReplayField(
          source,
          key,
          item,
          currentAssistantRoute,
        );
        if (sanitizedReplayField !== undefined) {
          if (sanitizedReplayField !== item) {
            next ??= { ...source };
            next[key] = sanitizedReplayField;
          }
          continue;
        }
      }
      if (typeof item === "string") {
        const sanitizedDataUrl = sanitizeTranscriptImageDataUrlField({
          source,
          key,
          value: item,
          preserveImageDataUrlFields,
        });
        if (sanitizedDataUrl !== undefined) {
          if (sanitizedDataUrl !== item) {
            next ??= { ...source };
            next[key] = sanitizedDataUrl;
          }
          continue;
        }
      }
      if (key === "data" && sanitizedImageRecord) {
        continue;
      }
      const redacted =
        typeof item === "string" && sourceFields?.get(key) === item
          ? redactSourceInputTextWithConfig(item, resolveTranscriptLoggingConfig(cfg))
          : redactValue(
              item,
              key,
              preserveImageDataUrlFields ||
                shouldPreserveNestedTranscriptImageDataUrlFields(source, key),
              location === "root" &&
                source.role === "assistant" &&
                key === "content" &&
                Array.isArray(item)
                ? "assistant-content-array"
                : location === "root" && key === "details" && readNestedToolActivity(source)
                  ? "nested-tool-details"
                  : "nested",
              currentAssistantRoute,
              modelVisibleToolResult ||
                (location === "root" && source.role === "toolResult" && key === "content"),
              location === "assistant-content-block" && key === "arguments"
                ? sourceSlots?.get(source)
                : undefined,
            );
      if (redacted === item) {
        continue;
      }
      next ??= { ...source };
      next[key] = redacted;
    }
    // Redacted source facts no longer identify the producer's sender. Keep display
    // redaction, but never qualify the replacement bytes as a person or remote actor.
    if (fieldKey === "__openclaw" && next) {
      if (next.senderIdentity !== source.senderIdentity || next.senderId !== source.senderId) {
        delete next.senderIdentity;
      }
      if (next.humanMentions !== source.humanMentions) {
        delete next.humanMentions;
      }
    }
    if (location === "root" && source.role === "user" && next && next.content !== source.content) {
      const metadata = asOptionalRecord(next["__openclaw"]);
      if (metadata?.humanMentions !== undefined) {
        // UTF-16 selections cannot retain their binding after storage redacts the content.
        const retained = { ...metadata };
        delete retained.humanMentions;
        next["__openclaw"] = retained;
      }
    }
    seen.delete(value);
    if (next && modelVisibleToolResult) {
      copyPreparedModelVisibleToolText(source, next);
    }
    return next ?? value;
  };
  return redactValue(root, undefined, false, rootLocation);
}

/** Return a redacted transcript message according to logging config. */
export function redactTranscriptMessage(
  message: AgentMessage,
  cfg?: OpenClawConfig,
  sourceAppend?: CodeModeSourceAppend,
): AgentMessage {
  const redacted = redactTranscriptStructuredValue(
    message,
    cfg,
    "root",
    readCodeModeSourceFields(message, sourceAppend),
  ) as AgentMessage;
  copyCodeModeSourceAppend(message, redacted, sourceAppend, (source) =>
    redactSourceInputTextWithConfig(source, resolveTranscriptLoggingConfig(cfg)),
  );
  return redacted;
}
