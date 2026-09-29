import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "./config.js";
import type { RedactPattern } from "./redact-pattern-runtime.js";
import { DEFAULT_REDACT_PATTERNS, TOOL_PAYLOAD_REDACT_PATTERNS } from "./redact-patterns.js";

type LoggingConfig = OpenClawConfig["logging"];
type RedactSensitiveMode = "off" | "tools";

export type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: readonly RedactPattern[];
  sensitiveFieldPatterns?: readonly RedactPattern[];
  urlCredentialReplacement?: string;
};

export function resolveToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const patterns =
    userPatterns && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : undefined;
  return { mode: "tools", patterns };
}

export function resolveModelVisibleToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const hasUserPatterns = userPatterns && userPatterns.length > 0;
  return {
    mode: "tools",
    urlCredentialReplacement: "REDACTED_SECRET_DO_NOT_USE",
    patterns: hasUserPatterns
      ? [...userPatterns, ...TOOL_PAYLOAD_REDACT_PATTERNS]
      : TOOL_PAYLOAD_REDACT_PATTERNS,
    sensitiveFieldPatterns: hasUserPatterns
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : DEFAULT_REDACT_PATTERNS,
  };
}
