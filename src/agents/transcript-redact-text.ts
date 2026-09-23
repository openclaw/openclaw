import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";

export function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const redactPatterns = cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns;
  return redactPatterns ? { redactPatterns } : undefined;
}

export function redactTranscriptText(
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  const loggingConfig = resolveTranscriptLoggingConfig(cfg);
  return modelVisibleToolResult
    ? redactModelVisibleToolPayloadTextWithConfig(value, loggingConfig)
    : redactToolPayloadTextWithConfig(value, loggingConfig);
}

export function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  // Preserve pagination state only in transcripts; value-pattern and global log redaction remain.
  return /^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i.test(key)
    ? redactTranscriptText(value, cfg, modelVisibleToolResult)
    : modelVisibleToolResult
      ? redactModelVisibleSensitiveFieldValueWithConfig(
          key,
          value,
          resolveTranscriptLoggingConfig(cfg),
        )
      : redactSensitiveFieldValueWithConfig(key, value, resolveTranscriptLoggingConfig(cfg));
}
