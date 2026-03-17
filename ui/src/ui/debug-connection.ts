/**
 * Ephemeral debug log storage for connection diagnostics.
 * Logs are stored in memory only and are cleared when the tab is closed.
 * Uses sessionStorage for tab persistence across refreshes, but never localStorage.
 */

export type DebugLogLevel = "info" | "warn" | "error" | "debug";

export type DebugLogEntry = {
  id: string;
  ts: number;
  level: DebugLogLevel;
  source: "websocket" | "gateway" | "lifecycle" | "logs";
  message: string;
  details?: unknown;
};

const MAX_LOG_ENTRIES = 500;
const STORAGE_KEY = "openclaw_debug_logs";

let logs: DebugLogEntry[] = [];
let enabled = false;

/**
 * Check if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
  return enabled;
}

/**
 * Enable or disable debug mode.
 * When enabled, logs are captured. When disabled, logs are not captured but existing logs are preserved.
 */
export function setDebugEnabled(value: boolean): void {
  enabled = value;
  if (enabled) {
    // Load from sessionStorage on enable
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        logs = JSON.parse(stored);
      }
    } catch {
      logs = [];
    }
  }
}

/**
 * Clear all debug logs.
 */
export function clearDebugLogs(): void {
  logs = [];
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get all debug logs.
 */
export function getDebugLogs(): DebugLogEntry[] {
  return [...logs];
}

/**
 * Add a debug log entry.
 * Only captures logs when debug mode is enabled.
 */
export function addDebugLog(
  level: DebugLogLevel,
  source: DebugLogLevel,
  message: string,
  details?: unknown,
): void {
  if (!enabled) {
    return;
  }

  const entry: DebugLogEntry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    level,
    source: source as DebugLogEntry["source"],
    message,
    details,
  };

  logs.push(entry);

  // Limit the number of stored entries
  if (logs.length > MAX_LOG_ENTRIES) {
    logs = logs.slice(-MAX_LOG_ENTRIES);
  }

  // Persist to sessionStorage
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
  } catch {
    // Ignore storage errors (e.g., quota exceeded)
  }
}

// Convenience functions for different log levels
export const debugLog = {
  info: (source: DebugLogEntry["source"], message: string, details?: unknown) =>
    addDebugLog("info", source, message, details),
  warn: (source: DebugLogEntry["source"], message: string, details?: unknown) =>
    addDebugLog("warn", source, message, details),
  error: (source: DebugLogEntry["source"], message: string, details?: unknown) =>
    addDebugLog("error", source, message, details),
  debug: (source: DebugLogEntry["source"], message: string, details?: unknown) =>
    addDebugLog("debug", source, message, details),
};

/**
 * Export logs as formatted text for clipboard copy.
 */
export function exportDebugLogsAsText(): string {
  const lines = logs.map((entry) => {
    const time = new Date(entry.ts).toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const source = entry.source.padEnd(10);
    let line = `[${time}] ${level} [${source}] ${entry.message}`;
    if (entry.details) {
      line += `\n  Details: ${JSON.stringify(entry.details, null, 2)}`;
    }
    return line;
  });
  return lines.join("\n");
}