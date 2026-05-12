import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveFieldValue, redactSensitiveText } from "../logging/redact.js";

function redactTranscriptOptions(cfg?: OpenClawConfig) {
  return {
    mode: cfg?.logging?.redactSensitive,
    patterns: cfg?.logging?.redactPatterns,
  };
}

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveFieldValue(key, value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredValue(
  value: unknown,
  cfg?: OpenClawConfig,
  fieldKey?: string,
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg);
    }
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(item, cfg, fieldKey);
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
    const redacted = redactTranscriptStructuredValue(item, cfg, key);
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  return next ?? value;
}

export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  return redactTranscriptStructuredValue(message, cfg) as AgentMessage;
}
