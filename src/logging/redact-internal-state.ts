import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSecretRedactionRegistryRevision } from "./secret-redaction-registry.js";

type LoggingConfig = OpenClawConfig["logging"];
type InternalLoggingConfig = NonNullable<LoggingConfig> & {
  [fullContextToolPayloadRedaction]: true;
};

const fullContextToolPayloadRedaction = Symbol("full-context-tool-payload-redaction");
type PreparedToolText = { text: string } & ReturnType<typeof captureModelVisibleRedactionPolicy>;
const preparedToolText = new WeakMap<object, PreparedToolText>();

export const fullContextToolPayloadRedactionState = {
  mark(loggingConfig: LoggingConfig): InternalLoggingConfig {
    return {
      ...loggingConfig,
      [fullContextToolPayloadRedaction]: true,
    };
  },
  isMarked(loggingConfig: LoggingConfig): boolean {
    return Boolean(
      (loggingConfig as InternalLoggingConfig | undefined)?.[fullContextToolPayloadRedaction],
    );
  },
};

export function captureModelVisibleRedactionPolicy(loggingConfig: LoggingConfig) {
  return {
    patterns: [...(loggingConfig?.redactPatterns ?? [])],
    fullContext: fullContextToolPayloadRedactionState.isMarked(loggingConfig),
    registryRevision: getSecretRedactionRegistryRevision(),
  };
}

export function matchesModelVisibleRedactionPolicy(
  policy: ReturnType<typeof captureModelVisibleRedactionPolicy>,
  loggingConfig: LoggingConfig,
): boolean {
  const patterns = loggingConfig?.redactPatterns ?? [];
  return (
    policy.registryRevision === getSecretRedactionRegistryRevision() &&
    policy.fullContext === fullContextToolPayloadRedactionState.isMarked(loggingConfig) &&
    policy.patterns.length === patterns.length &&
    policy.patterns.every((pattern, index) => pattern === patterns[index])
  );
}

export const modelVisibleToolTextRedactionState = {
  record(block: object, text: string, loggingConfig: LoggingConfig): void {
    preparedToolText.set(block, {
      text,
      ...captureModelVisibleRedactionPolicy(loggingConfig),
    });
  },
  matches(block: object, text: string, loggingConfig: LoggingConfig): boolean {
    const prepared = preparedToolText.get(block);
    return (
      prepared !== undefined &&
      prepared.text === text &&
      matchesModelVisibleRedactionPolicy(prepared, loggingConfig)
    );
  },
  copy(source: object, target: object, text: string): void {
    const prepared = preparedToolText.get(source);
    if (prepared?.text === text) {
      preparedToolText.set(target, prepared);
    }
  },
};
