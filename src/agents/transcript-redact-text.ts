import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  captureSensitiveTextRedactionSnapshot,
  type SensitiveTextRedactionSnapshot,
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";
import { withSecretRedactionRegistrySnapshot } from "../logging/secret-redaction-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type TranscriptRedactionSnapshot = SensitiveTextRedactionSnapshot & {
  readonly policyToken: number;
  readonly patterns: readonly string[];
  readonly retainedBytes: number;
};
const transcriptPolicy = resolveGlobalSingleton<{
  token: number;
  patterns?: readonly string[];
  registryRevision: number;
  scope: AsyncLocalStorage<TranscriptRedactionSnapshot>;
}>(Symbol.for("openclaw.transcriptRedactionPolicy"), () => ({
  token: 0,
  registryRevision: -1,
  scope: new AsyncLocalStorage<TranscriptRedactionSnapshot>(),
}));

/** Contains exact secret values for trusted worker redaction; never log or use it as a cache key. */
export function captureTranscriptRedactionSnapshot(): TranscriptRedactionSnapshot {
  const patterns = [...(readLoggingConfig()?.redactPatterns ?? [])];
  const snapshot = captureSensitiveTextRedactionSnapshot();
  if (
    snapshot.registryRevision !== transcriptPolicy.registryRevision ||
    patterns.length !== transcriptPolicy.patterns?.length ||
    patterns.some((pattern, index) => pattern !== transcriptPolicy.patterns?.[index])
  ) {
    transcriptPolicy.token++;
    transcriptPolicy.patterns = patterns;
    transcriptPolicy.registryRevision = snapshot.registryRevision;
  }
  return {
    ...snapshot,
    patterns,
    policyToken: transcriptPolicy.token,
    retainedBytes:
      512 +
      [...patterns, ...snapshot.registeredSecretValues].reduce(
        (bytes, value) => bytes + value.length * 2 + 16,
        0,
      ),
  };
}

export function withTranscriptRedactionSnapshot<T>(
  snapshot: TranscriptRedactionSnapshot,
  run: () => T,
): T {
  return withSecretRedactionRegistrySnapshot(
    { revision: snapshot.registryRevision, values: snapshot.registeredSecretValues },
    () => transcriptPolicy.scope.run(snapshot, run),
  );
}

export function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const redactPatterns =
    cfg?.logging?.redactPatterns ??
    transcriptPolicy.scope.getStore()?.patterns ??
    readLoggingConfig()?.redactPatterns;
  return redactPatterns ? { redactPatterns: [...redactPatterns] } : undefined;
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
