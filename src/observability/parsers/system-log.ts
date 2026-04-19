import type { ParsedEvent, LogParser } from "./index.js";

/**
 * tslog JSON format fields.
 * System logs use tslog which outputs structured JSON.
 */
type TsLogEntry = {
  _meta?: {
    date?: string;
    logLevelId?: number;
    logLevelName?: string;
    name?: string;
    path?: { fullFilePath?: string };
    runtime?: string;
  };
  date?: string;
  logLevel?: number;
  logLevelName?: string;
  subsystem?: string;
  message?: string;
  msg?: string;
  0?: unknown;
  1?: unknown;
  [key: string]: unknown;
};

const LOG_LEVEL_MAP: Record<number, string> = {
  0: "silly",
  1: "trace",
  2: "debug",
  3: "info",
  4: "warn",
  5: "error",
  6: "fatal",
};

function extractLogLevel(entry: TsLogEntry): string | undefined {
  if (entry._meta?.logLevelName) {
    return entry._meta.logLevelName.toLowerCase();
  }
  if (entry.logLevelName) {
    return entry.logLevelName.toLowerCase();
  }
  const levelId = entry._meta?.logLevelId ?? entry.logLevel;
  if (typeof levelId === "number" && LOG_LEVEL_MAP[levelId]) {
    return LOG_LEVEL_MAP[levelId];
  }
  return undefined;
}

function extractTimestamp(entry: TsLogEntry): string {
  // Check various places tslog might put the timestamp
  if (entry._meta?.date) {
    return entry._meta.date;
  }
  if (entry.date && typeof entry.date === "string") {
    return entry.date;
  }
  // Fallback to current time
  return new Date().toISOString();
}

function extractMessage(entry: TsLogEntry): string | undefined {
  // tslog puts the message in positional arguments (0, 1, etc.)
  // or in a 'message' or 'msg' field
  if (entry.message && typeof entry.message === "string") {
    return entry.message;
  }
  if (entry.msg && typeof entry.msg === "string") {
    return entry.msg;
  }
  // Check for positional arguments
  const firstArg = entry[0];
  if (typeof firstArg === "string") {
    return firstArg;
  }
  if (firstArg && typeof firstArg === "object") {
    const obj = firstArg as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
  }
  return undefined;
}

function extractSubsystem(entry: TsLogEntry): string | undefined {
  if (entry._meta?.name) {
    return entry._meta.name;
  }
  if (entry.subsystem && typeof entry.subsystem === "string") {
    return entry.subsystem;
  }
  return undefined;
}

/**
 * Parses a single line of tslog JSON output.
 */
export function parseSystemLogLine(line: string, sourceFile: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let entry: TsLogEntry;
  try {
    entry = JSON.parse(trimmed) as TsLogEntry;
  } catch {
    return null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const ts = extractTimestamp(entry);
  const level = extractLogLevel(entry);
  const message = extractMessage(entry);
  const subsystem = extractSubsystem(entry);

  // Determine event type from subsystem or level
  let eventType = "log";
  if (subsystem) {
    eventType = `log:${subsystem}`;
  }

  return {
    ts,
    sourceType: "system-log",
    sourceFile,
    eventType,
    level,
    messagePreview: message?.slice(0, 500),
    rawJson: trimmed,
  };
}

/**
 * System log parser for tslog JSON format.
 */
export const systemLogParser: LogParser = {
  sourceType: "system-log",
  parseLine: parseSystemLogLine,
};
