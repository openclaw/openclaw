import type { AgentMessage } from "@openclaw/agent-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getOpenClawSystemUpdateKind,
  isOpenClawSystemUpdateMessage,
} from "../../packages/agent-core/src/operator-messages.js";
import { parseNonNegativeByteSize } from "../config/byte-size.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const BOUNDED_CONTEXT_NOTICE =
  "⚠️ Continuing with bounded recent context. Older history outside that window is omitted for this turn; resend any earlier details needed for your request. Full history remains saved.";

/** Anthropic clears these bodies at later user-role messages; saved replay stays unchanged. */
export function resolveExpiredRuntimeContextContentBytes(
  messages: readonly AgentMessage[],
): Map<AgentMessage, number> {
  const expired = new Map<AgentMessage, number>();
  let cleared = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if ("excludeFromContext" in message && message.excludeFromContext === true) {
      continue;
    }
    if (isOpenClawSystemUpdateMessage(message)) {
      if (
        cleared &&
        getOpenClawSystemUpdateKind(message) === "runtime-context" &&
        message.role === "custom" &&
        asOptionalRecord(message.details)?.turnScoped === true &&
        typeof message.content === "string"
      ) {
        // Retain the field, quotes, and event envelope in the conservative byte charge.
        expired.set(message, Buffer.byteLength(JSON.stringify(message.content), "utf8") - 2);
      }
      continue;
    }
    if (message.role === "toolResult") {
      cleared = true;
    } else if ((message.role === "user" && !message.operatorMessage) || message.role === "custom") {
      cleared ||=
        typeof message.content === "string"
          ? message.content.trim().length > 0
          : message.content.some(
              (block) =>
                block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
            );
    }
  }
  return expired;
}

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const parsed = parseNonNegativeByteSize(
    cfg?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

/** A failed/no-progress byte attempt rearms only after another threshold of growth. */
export function refreshTranscriptByteCompactionLatch(
  latch: InternalSessionEntry["transcriptByteCompactionLatch"],
  sessionId: string,
  maxBytes: number | undefined,
  activeBytes: number | undefined,
): InternalSessionEntry["transcriptByteCompactionLatch"] {
  if (
    !latch ||
    maxBytes === undefined ||
    latch.sessionId !== sessionId ||
    latch.maxBytes !== maxBytes
  ) {
    return undefined;
  }
  if (activeBytes === undefined) {
    return latch;
  }
  if (activeBytes < maxBytes || activeBytes - latch.activeBytes >= maxBytes) {
    return undefined;
  }
  return activeBytes < latch.activeBytes ? { ...latch, activeBytes } : latch;
}
