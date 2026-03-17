import { type JSX } from "preact";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface DebugLogEntry {
  timestamp: number;
  level: LogLevel;
  type: string;
  message: string;
  data?: unknown;
}

const MAX_LOGS = 500;

class DebugConnectionManager {
  private logs: DebugLogEntry[] = [];
  private enabled = false;
  private listeners: Set<(logs: DebugLogEntry[]) => void> = new Set();

  isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.clear();
    }
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
    this.clear();
  }

  clear(): void {
    this.logs = [];
    this.notify();
  }

  log(level: LogLevel, type: string, message: string, data?: unknown): void {
    if (!this.enabled) return;

    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      level,
      type,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS);
    }
    this.notify();
  }

  info(type: string, message: string, data?: unknown): void {
    this.log("info", type, message, data);
  }

  warn(type: string, message: string, data?: unknown): void {
    this.log("warn", type, message, data);
  }

  error(type: string, message: string, data?: unknown): void {
    this.log("error", type, message, data);
  }

  debug(type: string, message: string, data?: unknown): void {
    this.log("debug", type, message, data);
  }

  getLogs(): DebugLogEntry[] {
    return [...this.logs];
  }

  subscribe(listener: (logs: DebugLogEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const logs = this.getLogs();
    this.listeners.forEach((listener) => listener(logs));
  }

  exportLogs(): string {
    return this.logs
      .map(
        (entry) =>
          `[${new Date(entry.timestamp).toISOString()}] [${entry.level.toUpperCase()}] [${entry.type}] ${entry.message}${entry.data ? ` ${JSON.stringify(entry.data)}` : ""}`
      )
      .join("\n");
  }
}

export const debugConnection = new DebugConnectionManager();

// Hook for UI components
export function useDebugConnection() {
  return {
    isEnabled: debugConnection.isEnabled(),
    toggle: debugConnection.toggle.bind(debugConnection),
    logs: debugConnection.getLogs(),
    clear: debugConnection.clear.bind(debugConnection),
    exportLogs: debugConnection.exportLogs.bind(debugConnection),
  };
}
