// Shared JSON console envelope formatting for captured and pre-capture diagnostics.
import { stripVTControlCharacters } from "node:util";
import { readLoggingConfig } from "./config.js";
import type { LogLevel } from "./levels.js";
import { redactLogRecordForTransport } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";

export function formatJsonConsoleLine(params: {
  level: LogLevel;
  message: string;
  subsystem?: string;
  meta?: Record<string, unknown>;
}): string {
  const envelope = {
    ...params.meta,
    time: formatTimestamp(new Date(), { style: "long" }),
    level: params.level,
    ...(params.subsystem ? { subsystem: params.subsystem } : {}),
    message: params.message,
  };
  return JSON.stringify(redactLogRecordForTransport(envelope, { format: "console" }));
}

/** Formats diagnostics that must bypass console capture without bypassing JSON console style. */
export function formatConsoleDiagnosticLine(params: { level: LogLevel; message: string }): string {
  const override = loggingState.overrideSettings as { consoleStyle?: unknown } | null;
  const style = override?.consoleStyle ?? readLoggingConfig()?.consoleStyle;
  return style === "json" ? formatJsonConsoleLine(params) : params.message;
}

/** Preserves human diagnostic blocks while serializing the whole block as one JSONL record. */
export function formatConsoleDiagnosticBlock(params: { level: LogLevel; message: string }): string {
  const override = loggingState.overrideSettings as { consoleStyle?: unknown } | null;
  const style = override?.consoleStyle ?? readLoggingConfig()?.consoleStyle;
  if (style !== "json") {
    return params.message;
  }
  const trailingNewline = params.message.endsWith("\n") ? "\n" : "";
  return `${formatJsonConsoleLine({
    level: params.level,
    message: stripVTControlCharacters(params.message).trimEnd(),
  })}${trailingNewline}`;
}
