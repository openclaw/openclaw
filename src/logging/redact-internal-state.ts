import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSecretRedactionRegistryRevision } from "./secret-redaction-registry.js";

type LoggingConfig = OpenClawConfig["logging"];
type InternalLoggingConfig = NonNullable<LoggingConfig> & {
  [fullContextToolPayloadRedaction]: true;
};

const fullContextToolPayloadRedaction = Symbol("full-context-tool-payload-redaction");
type PreparedToolText = {
  text: string;
  patterns: readonly string[];
  fullContext: boolean;
  registryRevision: number;
};
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

export const modelVisibleToolTextRedactionState = {
  record(block: object, text: string, loggingConfig: LoggingConfig): void {
    preparedToolText.set(block, {
      text,
      patterns: [...(loggingConfig?.redactPatterns ?? [])],
      fullContext: fullContextToolPayloadRedactionState.isMarked(loggingConfig),
      registryRevision: getSecretRedactionRegistryRevision(),
    });
  },
  matches(block: object, text: string, loggingConfig: LoggingConfig): boolean {
    const prepared = preparedToolText.get(block);
    const patterns = loggingConfig?.redactPatterns ?? [];
    return (
      prepared !== undefined &&
      prepared.text === text &&
      prepared.registryRevision === getSecretRedactionRegistryRevision() &&
      prepared.fullContext === fullContextToolPayloadRedactionState.isMarked(loggingConfig) &&
      prepared.patterns.length === patterns.length &&
      prepared.patterns.every((pattern, index) => pattern === patterns[index])
    );
  },
  copy(source: object, target: object, text: string): void {
    const prepared = preparedToolText.get(source);
    if (prepared?.text === text) {
      preparedToolText.set(target, prepared);
    }
  },
};
