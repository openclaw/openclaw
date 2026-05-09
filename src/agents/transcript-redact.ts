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

function redactTranscriptStructuredValue(value: unknown, cfg?: OpenClawConfig): unknown {
  if (typeof value === "string") {
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(item, cfg);
      changed ||= next !== item;
      return next;
    });
    return changed ? redacted : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(source)) {
    const redacted = redactTranscriptStructuredValue(item, cfg);
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  return next ?? value;
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
  if (source.type === "toolCall" && "arguments" in source) {
    const redactedArguments = redactTranscriptStructuredValue(source.arguments, cfg);
    if (redactedArguments !== source.arguments) {
      next ??= { ...source };
      next.arguments = redactedArguments;
    }
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
  let next: Record<string, unknown> | null = null;
  const assignStringField = (key: string) => {
    const value = source[key];
    if (typeof value !== "string") {
      return;
    }
    const redacted = redactTranscriptText(value, cfg);
    if (redacted === value) {
      return;
    }
    next ??= { ...source };
    next[key] = redacted;
  };
  if (redactedContent !== source.content) {
    next ??= { ...source };
    next.content = redactedContent;
  }
  assignStringField("command");
  assignStringField("output");
  assignStringField("summary");
  assignStringField("errorMessage");
  return (next ?? message) as unknown as AgentMessage;
}
