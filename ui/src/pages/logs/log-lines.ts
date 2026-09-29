import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { parseLogLine as parseCoreLogLine } from "../../../../src/logging/parse-log-line.js";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
};

export const DEFAULT_LOG_LEVEL_FILTERS: Record<LogLevel, boolean> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
};

export function parseLogLine(line: string): LogEntry {
  const parsed = parseCoreLogLine(line);
  if (!parsed) {
    return { raw: line, message: stripAnsi(line) };
  }
  const subsystem = parsed.subsystem ?? parsed.module;
  return {
    raw: parsed.raw,
    time: parsed.time ?? null,
    level: LOG_LEVELS.find((level) => level === parsed.level) ?? null,
    subsystem: subsystem ? stripAnsi(subsystem) : null,
    message: stripAnsi(parsed.message),
  };
}
