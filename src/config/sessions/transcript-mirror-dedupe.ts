import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionTranscriptTurnWriteContext } from "./session-accessor.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type { SessionTranscriptAssistantMessage } from "./transcript-assistant-message.js";

export function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return (
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === OPENCLAW_DELIVERY_MIRROR_MODEL
  );
}

async function readLatestVisibleTranscriptMessage(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ id?: string; message: unknown } | undefined> {
  try {
    const event = (await prepareSessionTranscriptHydration(scope).readLatestActiveMessage())?.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return undefined;
    }
    // SAFETY: The non-array object was checked above; optional fields remain unknown until narrowed.
    const record = event as { id?: unknown; message?: unknown };
    if (record.message === undefined) {
      return undefined;
    }
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      message: record.message,
    };
  } catch (error) {
    rethrowIncognitoSessionError(error);
    // Mirror deduplication remains best-effort when transcript reads are unavailable.
    return undefined;
  }
}

function extractAssistantMessageText(message: AgentMessage): string | null {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

export async function findLatestEquivalentDeliveryMirrorMessageId(
  target: SessionTranscriptTurnWriteContext,
  message: SessionTranscriptAssistantMessage,
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(redactTranscriptMessage(message, config));
  if (!expectedText) {
    return undefined;
  }

  if (target.storePath && target.sessionId && target.agentId && target.sessionKey) {
    const latest = await readLatestVisibleTranscriptMessage({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    });
    // SAFETY: Only the optional role discriminator is read; optional chaining handles absent bodies.
    const latestMessage = latest?.message as { role?: unknown } | undefined;
    if (latestMessage?.role !== "assistant") {
      return undefined;
    }
    const candidateText = latest
      ? extractAssistantMessageText(
          redactTranscriptMessage(
            // SAFETY: Active-message hydration decodes persisted AgentMessage bodies; the assistant role was checked above.
            latest.message as AgentMessage,
            config,
          ),
        )
      : undefined;
    return candidateText === expectedText ? latest?.id : undefined;
  }

  return undefined;
}
