import type { GatewayBrowserClient } from "../gateway.ts";
import type { LogEntry, LogLevel } from "../types.ts";

export type LogsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  logsLoading: boolean;
  logsError: string | null;
  logsCursor: number | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsTruncated: boolean;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
};

const LOG_BUFFER_LIMIT = 2000;
const LEVELS = new Set<LogLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

function parseMaybeJsonString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = value.toLowerCase() as LogLevel;
  return LEVELS.has(lowered) ? lowered : null;
}

function formatLogValue(value: unknown, depth = 0): string {
  if (value == null) {
    return "";
  }
  if (depth > 5) {
    return "[Max Depth]";
  }
  if (typeof value === "string") {
    const parsed = parseMaybeJsonString(value);
    if (parsed) {
      return formatLogValue(parsed, depth + 1);
    }
    return value;
  }
  if (typeof value === "object") {
    // If it's a simple object with a 'message' or 'text' or 'summary' field, use that.
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.summary === "string") {
      return obj.summary;
    }
    // Otherwise, stringify it cleanly with indentation.
    // JSON.stringify naturally handles circular refs by throwing,
    // but the depth limit above prevents stack overflow from nesting.
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "[Circular or Large Object]";
    }
  }
  return typeof value === "symbol" ? value.toString() : JSON.stringify(value);
}

export function parseLogLine(line: string): LogEntry {
  if (!line.trim()) {
    return { raw: line, message: line };
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const meta =
      obj && typeof obj._meta === "object" && obj._meta !== null
        ? (obj._meta as Record<string, unknown>)
        : null;
    const time =
      typeof obj.time === "string" ? obj.time : typeof meta?.date === "string" ? meta?.date : null;
    const level = normalizeLevel(meta?.logLevelName ?? meta?.level);

    const contextCandidate =
      typeof obj["0"] === "string" ? obj["0"] : typeof meta?.name === "string" ? meta?.name : null;
    const contextObj = parseMaybeJsonString(contextCandidate);
    let subsystem: string | null = null;
    if (contextObj) {
      if (typeof contextObj.subsystem === "string") {
        subsystem = contextObj.subsystem;
      } else if (typeof contextObj.module === "string") {
        subsystem = contextObj.module;
      }
    }
    if (!subsystem && contextCandidate && contextCandidate.length < 120) {
      subsystem = contextCandidate;
    }

    const messageParts: string[] = [];
    if (typeof obj["1"] !== "undefined") {
      messageParts.push(formatLogValue(obj["1"]));
    }
    if (typeof obj["2"] !== "undefined") {
      messageParts.push(formatLogValue(obj["2"]));
    }

    if (messageParts.length === 0) {
      if (!contextObj && typeof obj["0"] !== "undefined") {
        messageParts.push(formatLogValue(obj["0"]));
      } else if (typeof obj.message === "string") {
        messageParts.push(obj.message);
      }
    }

    const message = messageParts.filter(Boolean).join(" ");

    return {
      raw: line,
      time,
      level,
      subsystem,
      message: message || line,
      meta: meta ?? undefined,
    };
  } catch {
    return { raw: line, message: line };
  }
}

export async function loadLogs(state: LogsState, opts?: { reset?: boolean; quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.logsLoading && !opts?.quiet) {
    return;
  }
  if (!opts?.quiet) {
    state.logsLoading = true;
  }
  state.logsError = null;
  try {
    const res = await state.client.request("logs.tail", {
      cursor: opts?.reset ? undefined : (state.logsCursor ?? undefined),
      limit: state.logsLimit,
      maxBytes: state.logsMaxBytes,
    });
    const payload = res as {
      file?: string;
      cursor?: number;
      size?: number;
      lines?: unknown;
      truncated?: boolean;
      reset?: boolean;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line) => typeof line === "string")
      : [];
    const entries = lines.map(parseLogLine);
    const shouldReset = Boolean(opts?.reset || payload.reset || state.logsCursor == null);
    state.logsEntries = shouldReset
      ? entries
      : [...state.logsEntries, ...entries].slice(-LOG_BUFFER_LIMIT);
    if (typeof payload.cursor === "number") {
      state.logsCursor = payload.cursor;
    }
    if (typeof payload.file === "string") {
      state.logsFile = payload.file;
    }
    state.logsTruncated = Boolean(payload.truncated);
    state.logsLastFetchAt = Date.now();
  } catch (err) {
    state.logsError = String(err);
  } finally {
    if (!opts?.quiet) {
      state.logsLoading = false;
    }
  }
}
