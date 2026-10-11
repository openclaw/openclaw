import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import type { AgentMessage } from "./agent-core.js";

export function findLatestEquivalentAssistantMessageId(
  events: readonly unknown[],
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
  excludeDeliveryMirrors = false,
): string | undefined {
  const expectedText = extractAssistantMirrorComparableText(message, config);
  if (!expectedText) {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event)) {
      continue;
    }
    const candidate = event.message;
    if (!candidate) {
      continue;
    }
    if (!isAgentMessageRecord(candidate)) {
      return undefined;
    }
    if (
      candidate.role !== "assistant" ||
      (excludeDeliveryMirrors && isDeliveryMirrorAssistantMessage(candidate))
    ) {
      return undefined;
    }
    return extractAssistantMirrorComparableText(candidate, config) === expectedText &&
      typeof event.id === "string" &&
      event.id
      ? event.id
      : undefined;
  }
  return undefined;
}

export function findEquivalentAssistantMessageInRun(
  events: readonly unknown[],
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
  runId: string,
): string | undefined {
  const expectedText = extractAssistantMirrorComparableText(message, config);
  if (!expectedText) {
    return undefined;
  }
  const correlatedIds = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.message)) {
      continue;
    }
    const marker = event.message.openclawDeliveryMirror;
    if (isRecord(marker) && typeof marker.sourceAssistantMessageId === "string") {
      correlatedIds.add(marker.sourceAssistantMessageId);
    }
  }
  // Queued answers settle in delivery order, which need not be the transcript tail.
  // Consume each stored occurrence once, including repeated text within one run.
  for (const event of events) {
    if (!isRecord(event) || !isAgentMessageRecord(event.message) || typeof event.id !== "string") {
      continue;
    }
    const candidate = event.message;
    if (
      candidate.role === "assistant" &&
      !isDeliveryMirrorAssistantMessage(candidate) &&
      readSessionTranscriptRunId(candidate) === runId &&
      !correlatedIds.has(event.id) &&
      extractAssistantMirrorComparableText(candidate, config) === expectedText
    ) {
      return event.id;
    }
  }
  return undefined;
}

function extractAssistantMirrorComparableText(
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
): string | undefined {
  const redacted = redactTranscriptMessage(
    message as Parameters<typeof redactTranscriptMessage>[0], // SAFETY: this stored assistant has the redactor's message envelope.
    config,
  );
  return extractAssistantPhaseText(redacted)?.trim() || undefined;
}

export function isDeliveryMirrorAssistantMessage(
  message: SessionTranscriptAssistantMessage,
): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

export function isAgentMessageRecord(
  value: unknown,
): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && readNonEmptyString(value.role) !== undefined;
}
