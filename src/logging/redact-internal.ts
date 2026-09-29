import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  fullContextToolPayloadRedactionState,
  modelVisibleToolTextRedactionState,
} from "./redact-internal-state.js";

type LoggingConfig = OpenClawConfig["logging"];

export function isFullContextToolPayloadRedaction(loggingConfig: LoggingConfig): boolean {
  return fullContextToolPayloadRedactionState.isMarked(loggingConfig);
}

export function isPreparedModelVisibleToolText(
  block: object,
  text: string,
  loggingConfig: LoggingConfig,
): boolean {
  return modelVisibleToolTextRedactionState.matches(block, text, loggingConfig);
}

export function copyPreparedModelVisibleToolText(
  source: { text?: unknown },
  target: { text?: unknown },
): void {
  const text = source.text;
  if (typeof text === "string" && text === target.text) {
    modelVisibleToolTextRedactionState.copy(source, target, text);
  }
}
