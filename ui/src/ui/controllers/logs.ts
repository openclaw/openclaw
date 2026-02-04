<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
import type { LogEntry, LogLevel } from "../types";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
import type { LogEntry, LogLevel } from "../types.ts";
>>>>>>> upstream/main

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
<<<<<<< HEAD
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
=======
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
>>>>>>> upstream/main
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeLevel(value: unknown): LogLevel | null {
<<<<<<< HEAD
  if (typeof value !== "string") return null;
=======
  if (typeof value !== "string") {
    return null;
  }
>>>>>>> upstream/main
  const lowered = value.toLowerCase() as LogLevel;
  return LEVELS.has(lowered) ? lowered : null;
}

export function parseLogLine(line: string): LogEntry {
<<<<<<< HEAD
  if (!line.trim()) return { raw: line, message: line };
=======
  if (!line.trim()) {
    return { raw: line, message: line };
  }
>>>>>>> upstream/main
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
<<<<<<< HEAD
      typeof obj["0"] === "string"
        ? (obj["0"] as string)
        : typeof meta?.name === "string"
          ? (meta?.name as string)
          : null;
    const contextObj = parseMaybeJsonString(contextCandidate);
    let subsystem: string | null = null;
    if (contextObj) {
      if (typeof contextObj.subsystem === "string") subsystem = contextObj.subsystem;
      else if (typeof contextObj.module === "string") subsystem = contextObj.module;
=======
      typeof obj["0"] === "string" ? obj["0"] : typeof meta?.name === "string" ? meta?.name : null;
    const contextObj = parseMaybeJsonString(contextCandidate);
    let subsystem: string | null = null;
    if (contextObj) {
      if (typeof contextObj.subsystem === "string") {
        subsystem = contextObj.subsystem;
      } else if (typeof contextObj.module === "string") {
        subsystem = contextObj.module;
      }
>>>>>>> upstream/main
    }
    if (!subsystem && contextCandidate && contextCandidate.length < 120) {
      subsystem = contextCandidate;
    }

    let message: string | null = null;
<<<<<<< HEAD
    if (typeof obj["1"] === "string") message = obj["1"] as string;
    else if (!contextObj && typeof obj["0"] === "string") message = obj["0"] as string;
    else if (typeof obj.message === "string") message = obj.message as string;
=======
    if (typeof obj["1"] === "string") {
      message = obj["1"];
    } else if (!contextObj && typeof obj["0"] === "string") {
      message = obj["0"];
    } else if (typeof obj.message === "string") {
      message = obj.message;
    }
>>>>>>> upstream/main

    return {
      raw: line,
      time,
      level,
      subsystem,
      message: message ?? line,
      meta: meta ?? undefined,
    };
  } catch {
    return { raw: line, message: line };
  }
}

export async function loadLogs(state: LogsState, opts?: { reset?: boolean; quiet?: boolean }) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  if (state.logsLoading && !opts?.quiet) return;
  if (!opts?.quiet) state.logsLoading = true;
=======
  if (!state.client || !state.connected) {
    return;
  }
  if (state.logsLoading && !opts?.quiet) {
    return;
  }
  if (!opts?.quiet) {
    state.logsLoading = true;
  }
>>>>>>> upstream/main
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
<<<<<<< HEAD
      ? (payload.lines.filter((line) => typeof line === "string") as string[])
=======
      ? payload.lines.filter((line) => typeof line === "string")
>>>>>>> upstream/main
      : [];
    const entries = lines.map(parseLogLine);
    const shouldReset = Boolean(opts?.reset || payload.reset || state.logsCursor == null);
    state.logsEntries = shouldReset
      ? entries
      : [...state.logsEntries, ...entries].slice(-LOG_BUFFER_LIMIT);
<<<<<<< HEAD
    if (typeof payload.cursor === "number") state.logsCursor = payload.cursor;
    if (typeof payload.file === "string") state.logsFile = payload.file;
=======
    if (typeof payload.cursor === "number") {
      state.logsCursor = payload.cursor;
    }
    if (typeof payload.file === "string") {
      state.logsFile = payload.file;
    }
>>>>>>> upstream/main
    state.logsTruncated = Boolean(payload.truncated);
    state.logsLastFetchAt = Date.now();
  } catch (err) {
    state.logsError = String(err);
  } finally {
<<<<<<< HEAD
    if (!opts?.quiet) state.logsLoading = false;
=======
    if (!opts?.quiet) {
      state.logsLoading = false;
    }
>>>>>>> upstream/main
  }
}
