import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveText } from "../logging/redact.js";

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, {
    mode: cfg?.logging?.redactSensitive,
    patterns: cfg?.logging?.redactPatterns,
  });
}

function redactTranscriptContentBlock(block: unknown, cfg?: OpenClawConfig): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }
  const source = block as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const assign = (key: string, value: string) => {
    const redacted = redactTranscriptText(value, cfg);
    if (redacted === value) {
      return;
    }
    next ??= { ...source };
    next[key] = redacted;
  };

  if (typeof source.text === "string") {
    assign("text", source.text);
  }
  if (typeof source.thinking === "string") {
    assign("thinking", source.thinking);
  }
  if (typeof source.partialJson === "string") {
    assign("partialJson", source.partialJson);
  }
  return next ?? block;
}

function redactTranscriptContent(content: unknown, cfg?: OpenClawConfig): unknown {
  if (typeof content === "string") {
    return redactTranscriptText(content, cfg);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  let changed = false;
  const redacted = content.map((block) => {
    const next = redactTranscriptContentBlock(block, cfg);
    changed ||= next !== block;
    return next;
  });
  return changed ? redacted : content;
}

export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  const source = message as unknown as Record<string, unknown>;
  const redactedContent = redactTranscriptContent(source.content, cfg);
  if (redactedContent === source.content) {
    return message;
  }
  return {
    ...source,
    content: redactedContent,
  } as unknown as AgentMessage;
}
