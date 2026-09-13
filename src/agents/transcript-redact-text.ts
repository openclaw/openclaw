/**
 * Transcript write-side redaction helpers.
 *
 * These are the calls the transcript persistence path makes into logging redaction, so
 * they are also what opts into redaction provenance: every mask they produce is wrapped
 * for replay, and replay rewrites only wrapped spans (#142821).
 */
import {
  escapeRawRedactionProvenanceLiterals,
  escapeRedactionProvenanceLiterals,
  hasRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import { redactSourceInputTextWithConfig } from "../logging/redact-source.js";
import {
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
  withRedactionProvenance,
} from "../logging/redact.js";

export function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const redactPatterns = cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns;
  return redactPatterns ? { redactPatterns } : undefined;
}

/**
 * One persisted transcript string: masks are marked for replay, and literal bytes that
 * could be read as a mark are escaped, so replay can never mistake history for a mask
 * and repeated passes leave the bytes alone (#142821).
 *
 * Raw input is escaped first (every escape byte doubled), so a user-typed complete
 * mark cannot survive as a genuine mark; redaction then produces fresh single marks,
 * and the final escape fixes literal runs to a fixed point. When redaction produced no
 * mark, the escaped form is still what persistence writes: strings that carry no
 * reserved byte stay byte-identical, and strings that do keep the encoded/raw
 * distinction instead of storing bytes replay would read as provenance (#142821
 * review).
 *
 * `markMasks: false` is the model-visible tool-text dialect: those bytes were admitted
 * live by the delivery path (`prepareModelVisibleToolTextBlock`, #146596), so
 * persistence escapes literals but leaves produced masks bare, and replay reuses the
 * admitted result instead of rewriting it.
 */
function encodePersistedTranscriptText(
  raw: string,
  redactEscaped: (escapedRaw: string) => string,
  markMasks = true,
): string {
  const escapedRaw = escapeRawRedactionProvenanceLiterals(raw);
  const redacted = markMasks
    ? withRedactionProvenance(() => redactEscaped(escapedRaw))
    : redactEscaped(escapedRaw);
  if (hasRedactionProvenance(redacted)) {
    return escapeRedactionProvenanceLiterals(redacted);
  }
  // No fresh mark: keep the bytes redaction changed (truncation, omission, custom
  // patterns) and otherwise the escaped raw form — never the bare bytes a replay
  // could read as a mark (#142821 review).
  return redacted === escapedRaw ? escapedRaw : redacted;
}

export function redactTranscriptText(
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  const loggingConfig = resolveTranscriptLoggingConfig(cfg);
  // Persisted masks carry explicit provenance so replay never has to guess (#142821).
  return encodePersistedTranscriptText(
    value,
    (escaped) =>
      modelVisibleToolResult
        ? redactModelVisibleToolPayloadTextWithConfig(escaped, loggingConfig)
        : redactToolPayloadTextWithConfig(escaped, loggingConfig),
    !modelVisibleToolResult,
  );
}

export function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  // Preserve pagination state only in transcripts; value-pattern and global log redaction remain.
  // Page-token values already encode via redactTranscriptText: delegate directly to avoid
  // double-escaping already-encoded marks.
  if (/^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i.test(key)) {
    return redactTranscriptText(value, cfg, modelVisibleToolResult);
  }
  return encodePersistedTranscriptText(
    value,
    (escaped) =>
      modelVisibleToolResult
        ? redactModelVisibleSensitiveFieldValueWithConfig(
            key,
            escaped,
            resolveTranscriptLoggingConfig(cfg),
          )
        : redactSensitiveFieldValueWithConfig(key, escaped, resolveTranscriptLoggingConfig(cfg)),
    !modelVisibleToolResult,
  );
}

/** Source input text is persisted too, so its masks need the same provenance. */
export function redactTranscriptSourceInputText(value: string, cfg?: OpenClawConfig): string {
  return encodePersistedTranscriptText(value, (escaped) =>
    redactSourceInputTextWithConfig(escaped, resolveTranscriptLoggingConfig(cfg)),
  );
}
