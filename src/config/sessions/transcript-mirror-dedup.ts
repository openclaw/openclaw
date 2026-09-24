import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { redactTranscriptStructuredFieldValue } from "../../agents/transcript-redact-text.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  readLatestSessionTranscriptMessageEvent,
  type SessionTranscriptTurnWriteContext,
} from "./session-accessor.js";
import type { SessionTranscriptAssistantMessage } from "./transcript.js";

export function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return (
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === OPENCLAW_DELIVERY_MIRROR_MODEL
  );
}

async function readLatestVisibleTranscriptMessage(scope: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
}): Promise<{ id?: string; message: unknown } | undefined> {
  try {
    const record = asOptionalRecord(readLatestSessionTranscriptMessageEvent(scope)?.event);
    if (!record || record.message === undefined) {
      return undefined;
    }
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      message: record.message,
    };
  } catch {
    // Mirror deduplication remains best-effort when transcript reads are unavailable.
    return undefined;
  }
}

function extractAssistantMessageText(value: unknown, config?: OpenClawConfig): string | null {
  const message = asOptionalRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .flatMap((block: unknown) => {
      const part = asOptionalRecord(block);
      return part?.type === "text" && typeof part.text === "string"
        ? [redactTranscriptStructuredFieldValue("text", part.text, config).trim()]
        : [];
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

export async function findLatestEquivalentAssistantMessageId(
  target: SessionTranscriptTurnWriteContext,
  message: SessionTranscriptAssistantMessage,
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(message, config);
  if (!expectedText) {
    return undefined;
  }

  if (target.storePath && target.sessionId) {
    const latest = await readLatestVisibleTranscriptMessage({
      ...(target.agentId ? { agentId: target.agentId } : {}),
      sessionId: target.sessionId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      storePath: target.storePath,
    });
    const candidateText = extractAssistantMessageText(latest?.message, config);
    return candidateText === expectedText ? latest?.id : undefined;
  }

  return undefined;
}
