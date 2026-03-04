"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { LogEntry, LogLevel } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Constants
// ============================================

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "#71717a",
  debug: "#3b82f6",
  info: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
  fatal: "#dc2626",
};

// ============================================
// Helpers
// ============================================

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
  return LEVELS.includes(lowered) ? lowered : null;
}

function parseLogLine(line: string): LogEntry {
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

    let message: string | null = null;
    if (typeof obj["1"] === "string") {
      message = obj["1"];
    } else if (!contextObj && typeof obj["0"] === "string") {
      message = obj["0"];
    } else if (typeof obj.message === "string") {
      message = obj.message;
    }

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

function formatTime(value?: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function matchesFilter(entry: LogEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

// ============================================
// Styles
// ============================================

const styles = {
  card: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
    flexWrap: "wrap" as const,
    gap: 12,
  } as React.CSSProperties,
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: 0,
  } as React.CSSProperties,
  cardSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  btnGroup: {
    display: "flex",
    gap: 8,
  } as React.CSSProperties,
  btn: {
    height: 32,
    padding: "0 14px",
    fontSize: 13,
    fontWeight: 500,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  filters: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap" as const,
    alignItems: "center",
  } as React.CSSProperties,
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    fontSize: 13,
    minWidth: 220,
  } as React.CSSProperties,
  fieldCheckbox: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 8,
    minWidth: "auto",
  } as React.CSSProperties,
  fieldLabel: {
    color: "var(--muted)",
    fontSize: 12,
  } as React.CSSProperties,
  input: {
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    color: "var(--text)",
  } as React.CSSProperties,
  checkbox: {
    width: 16,
    height: 16,
    accentColor: "var(--accent)",
  } as React.CSSProperties,
  chipRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
    marginTop: 12,
  } as React.CSSProperties,
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 9999,
    cursor: "pointer",
    border: "1px solid var(--border)",
    background: "var(--bg)",
    transition: "background 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  chipActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-subtle)",
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 10,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
  } as React.CSSProperties,
  calloutWarning: {
    background: "rgba(245, 158, 11, 0.1)",
    color: "var(--warn)",
    border: "1px solid var(--warn)",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  logStream: {
    marginTop: 12,
    maxHeight: 500,
    overflowY: "auto" as const,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  } as React.CSSProperties,
  logRow: {
    display: "grid",
    gridTemplateColumns: "70px 60px 100px 1fr",
    gap: 12,
    padding: "6px 12px",
    borderBottom: "1px solid var(--border)",
    fontSize: 12,
    lineHeight: 1.5,
  } as React.CSSProperties,
  logTime: {
    fontFamily: "var(--mono)",
    color: "var(--muted)",
  } as React.CSSProperties,
  logLevel: {
    fontWeight: 600,
    textTransform: "uppercase" as const,
    fontSize: 11,
  } as React.CSSProperties,
  logSubsystem: {
    fontFamily: "var(--mono)",
    color: "var(--muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  logMessage: {
    fontFamily: "var(--mono)",
    color: "var(--text)",
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
};

// ============================================
// LogRow Component
// ============================================

function LogRow({ entry }: { entry: LogEntry }) {
  const levelColor = entry.level ? LEVEL_COLORS[entry.level] : "var(--muted)";

  return (
    <div style={styles.logRow}>
      <div style={styles.logTime}>{formatTime(entry.time)}</div>
      <div style={{ ...styles.logLevel, color: levelColor }}>{entry.level ?? ""}</div>
      <div style={styles.logSubsystem}>{entry.subsystem ?? ""}</div>
      <div style={styles.logMessage}>{entry.message ?? entry.raw}</div>
    </div>
  );
}

// ============================================
// LevelChip Component
// ============================================

function LevelChip({
  level,
  active,
  onToggle,
}: {
  level: LogLevel;
  active: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const color = LEVEL_COLORS[level];
  return (
    <label
      style={{
        ...styles.chip,
        ...(active ? { ...styles.chipActive, borderColor: color } : {}),
      }}
    >
      <input
        type="checkbox"
        checked={active}
        onChange={(e) => onToggle(e.target.checked)}
        style={{ display: "none" }}
      />
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? color : "var(--muted)",
        }}
      />
      <span style={{ color: active ? color : "var(--muted)" }}>{level}</span>
    </label>
  );
}

// ============================================
// Main Logs Page
// ============================================

type LogsTailResult = {
  lines: string[];
  file: string;
  truncated: boolean;
};

export default function LogsPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const [filterText, setFilterText] = useState("");
  const [levelFilters, setLevelFilters] = useState<Record<LogLevel, boolean>>({
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
  });
  const [autoFollow, setAutoFollow] = useState(true);

  const streamRef = useRef<HTMLDivElement>(null);

  const loadLogs = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await request<LogsTailResult>("logs.tail", {});
      const parsedEntries = (res.lines || []).map(parseLogLine);
      setEntries(parsedEntries);
      setFile(res.file ?? null);
      setTruncated(res.truncated ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [state, request]);

  useEffect(() => {
    if (state === "connected") {
      void loadLogs();
    }
  }, [state, loadLogs]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoFollow && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [entries, autoFollow]);

  const handleLevelToggle = (level: LogLevel, enabled: boolean) => {
    setLevelFilters((prev) => ({ ...prev, [level]: enabled }));
  };

  const handleExport = () => {
    const filtered = entries.filter((entry) => {
      if (entry.level && !levelFilters[entry.level]) {
        return false;
      }
      return matchesFilter(entry, filterText.trim().toLowerCase());
    });
    const content = filtered.map((e) => e.raw).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclaw-logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filter entries
  const needle = filterText.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (entry.level && !levelFilters[entry.level]) {
      return false;
    }
    return matchesFilter(entry, needle);
  });

  const isDisabled = loading || state !== "connected";

  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--text-strong)",
            margin: 0,
          }}
        >
          Logs
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          View and search gateway logs in real time.
        </p>
      </div>

      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Gateway Logs</div>
            <div style={styles.cardSub}>
              {state === "connected"
                ? `${filtered.length} entries`
                : state === "connecting"
                  ? "Connecting..."
                  : "Not connected"}
            </div>
          </div>
          <div style={styles.btnGroup}>
            <button style={styles.btn} disabled={isDisabled} onClick={loadLogs}>
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button style={styles.btn} disabled={filtered.length === 0} onClick={handleExport}>
              Export
            </button>
          </div>
        </div>

        <div style={styles.filters}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Filter</span>
            <input
              style={styles.input}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Search logs..."
            />
          </label>
          <label style={{ ...styles.field, ...styles.fieldCheckbox }}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
            />
            <span>Auto-follow</span>
          </label>
        </div>

        <div style={styles.chipRow}>
          {LEVELS.map((level) => (
            <LevelChip
              key={level}
              level={level}
              active={levelFilters[level]}
              onToggle={(enabled) => handleLevelToggle(level, enabled)}
            />
          ))}
        </div>

        {file && <div style={{ ...styles.muted, marginTop: 10 }}>File: {file}</div>}

        {truncated && (
          <div style={{ ...styles.callout, ...styles.calloutWarning }}>
            Log output truncated; showing latest chunk.
          </div>
        )}

        {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

        <div ref={streamRef} style={styles.logStream}>
          {filtered.length === 0 ? (
            <div style={{ ...styles.muted, padding: 12 }}>
              {loading ? "Loading logs..." : "No log entries."}
            </div>
          ) : (
            filtered.map((entry, i) => <LogRow key={i} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  );
}
