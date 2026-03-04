"use client";

import { useState, useCallback, useEffect } from "react";
import { formatRelativeTimestamp, formatSessionTokens, toNumber } from "@/lib/format";
import type { GatewaySessionRow, SessionsListResult } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Constants
// ============================================

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

// ============================================
// Helpers
// ============================================

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((opt) => opt.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: `${current} (custom)` }];
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  if (value === "on") {
    return "low";
  }
  return value;
}

// ============================================
// Styles
// ============================================

const styles = {
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
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
  btn: {
    height: 32,
    padding: "0 14px",
    fontSize: 13,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  btnDanger: {
    background: "var(--danger-subtle)",
    borderColor: "var(--danger)",
    color: "var(--danger)",
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
  } as React.CSSProperties,
  fieldCheckbox: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 8,
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    color: "var(--text)",
    width: 100,
  } as React.CSSProperties,
  checkbox: {
    width: 16,
    height: 16,
    accentColor: "var(--accent)",
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 12,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  table: {
    marginTop: 16,
    overflowX: "auto" as const,
  } as React.CSSProperties,
  tableHead: {
    display: "grid",
    gridTemplateColumns:
      "minmax(120px, 1.5fr) minmax(80px, 1fr) 80px 100px 80px 90px 90px 90px 80px",
    gap: 12,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.02em",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  tableRow: {
    display: "grid",
    gridTemplateColumns:
      "minmax(120px, 1.5fr) minmax(80px, 1fr) 80px 100px 80px 90px 90px 90px 80px",
    gap: 12,
    padding: "10px 12px",
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    fontSize: 13,
  } as React.CSSProperties,
  mono: {
    fontFamily: "var(--mono)",
    fontSize: 12,
  } as React.CSSProperties,
  sessionLink: {
    color: "var(--accent)",
    textDecoration: "none",
  } as React.CSSProperties,
  sessionDisplayName: {
    display: "block",
    fontSize: 11,
    color: "var(--muted)",
    marginTop: 2,
  } as React.CSSProperties,
  select: {
    height: 28,
    padding: "0 6px",
    fontSize: 12,
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
  } as React.CSSProperties,
  inputSmall: {
    height: 28,
    padding: "0 8px",
    fontSize: 12,
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    width: "100%",
  } as React.CSSProperties,
};

// ============================================
// SessionRow Component
// ============================================

type SessionRowProps = {
  row: GatewaySessionRow;
  disabled: boolean;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
};

function SessionRow({ row, disabled, onPatch, onDelete }: SessionRowProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(VERBOSE_LEVELS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);

  const displayName =
    typeof row.displayName === "string" && row.displayName.trim().length > 0
      ? row.displayName.trim()
      : null;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const showDisplayName = Boolean(displayName && displayName !== row.key && displayName !== label);
  const canLink = row.kind !== "global";
  const chatUrl = canLink ? `/chat?session=${encodeURIComponent(row.key)}` : null;

  return (
    <div style={styles.tableRow}>
      <div style={styles.mono}>
        {canLink && chatUrl ? (
          <a href={chatUrl} style={styles.sessionLink}>
            {row.key}
          </a>
        ) : (
          row.key
        )}
        {showDisplayName && <span style={styles.sessionDisplayName}>{displayName}</span>}
      </div>
      <div>
        <input
          style={styles.inputSmall}
          value={row.label ?? ""}
          disabled={disabled}
          placeholder="(optional)"
          onChange={(e) => {
            const value = e.target.value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
      </div>
      <div>{row.kind}</div>
      <div>{updated}</div>
      <div>{formatSessionTokens(row)}</div>
      <div>
        <select
          style={styles.select}
          disabled={disabled}
          value={thinking}
          onChange={(e) => {
            const value = e.target.value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          {thinkLevels.map((level) => (
            <option key={level} value={level}>
              {level || "inherit"}
            </option>
          ))}
        </select>
      </div>
      <div>
        <select
          style={styles.select}
          disabled={disabled}
          value={verbose}
          onChange={(e) => {
            const value = e.target.value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          {verboseLevels.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <select
          style={styles.select}
          disabled={disabled}
          value={reasoning}
          onChange={(e) => {
            const value = e.target.value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          {reasoningLevels.map((level) => (
            <option key={level} value={level}>
              {level || "inherit"}
            </option>
          ))}
        </select>
      </div>
      <div>
        <button
          style={{
            ...styles.btn,
            ...styles.btnDanger,
            height: 28,
            padding: "0 10px",
            fontSize: 12,
          }}
          disabled={disabled}
          onClick={() => onDelete(row.key)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ============================================
// Main Sessions Page
// ============================================

type Filters = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
};

export default function SessionsPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SessionsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    activeMinutes: "60",
    limit: "100",
    includeGlobal: true,
    includeUnknown: false,
  });

  const loadSessions = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = {
        activeMinutes: toNumber(filters.activeMinutes, 60),
        limit: toNumber(filters.limit, 100),
        includeGlobal: filters.includeGlobal,
        includeUnknown: filters.includeUnknown,
      };
      const res = await request<SessionsListResult>("sessions.list", params);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [state, request, filters]);

  useEffect(() => {
    if (state === "connected") {
      void loadSessions();
    }
  }, [state, loadSessions]);

  const handlePatch = useCallback(
    async (
      key: string,
      patch: {
        label?: string | null;
        thinkingLevel?: string | null;
        verboseLevel?: string | null;
        reasoningLevel?: string | null;
      },
    ) => {
      if (state !== "connected") {
        return;
      }

      try {
        await request("sessions.patch", { key, ...patch });
        // Refresh to get updated data
        await loadSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update session");
      }
    },
    [state, request, loadSessions],
  );

  const handleDelete = useCallback(
    async (key: string) => {
      if (state !== "connected") {
        return;
      }

      if (!confirm(`Delete session "${key}"?`)) {
        return;
      }

      try {
        await request("sessions.remove", { key });
        await loadSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete session");
      }
    },
    [state, request, loadSessions],
  );

  const handleFiltersChange = (next: Filters) => {
    setFilters(next);
  };

  const rows = result?.sessions ?? [];
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
          Sessions
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Active session keys and per-session overrides.
        </p>
      </div>

      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Sessions</div>
            <div style={styles.cardSub}>
              {state === "connected"
                ? `${rows.length} sessions loaded`
                : state === "connecting"
                  ? "Connecting to gateway..."
                  : "Not connected"}
            </div>
          </div>
          <button style={styles.btn} disabled={isDisabled} onClick={loadSessions}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        <div style={styles.filters}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Active within (minutes)</span>
            <input
              style={styles.input}
              value={filters.activeMinutes}
              onChange={(e) =>
                handleFiltersChange({
                  ...filters,
                  activeMinutes: e.target.value,
                })
              }
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Limit</span>
            <input
              style={styles.input}
              value={filters.limit}
              onChange={(e) => handleFiltersChange({ ...filters, limit: e.target.value })}
            />
          </label>
          <label style={{ ...styles.field, ...styles.fieldCheckbox }}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={filters.includeGlobal}
              onChange={(e) =>
                handleFiltersChange({
                  ...filters,
                  includeGlobal: e.target.checked,
                })
              }
            />
            <span>Include global</span>
          </label>
          <label style={{ ...styles.field, ...styles.fieldCheckbox }}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={filters.includeUnknown}
              onChange={(e) =>
                handleFiltersChange({
                  ...filters,
                  includeUnknown: e.target.checked,
                })
              }
            />
            <span>Include unknown</span>
          </label>
        </div>

        {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

        <div style={styles.muted}>{result ? `Store: ${result.path}` : ""}</div>

        <div style={styles.table}>
          <div style={styles.tableHead}>
            <div>Key</div>
            <div>Label</div>
            <div>Kind</div>
            <div>Updated</div>
            <div>Tokens</div>
            <div>Thinking</div>
            <div>Verbose</div>
            <div>Reasoning</div>
            <div>Actions</div>
          </div>
          {rows.length === 0 ? (
            <div style={{ ...styles.muted, padding: "20px 12px" }}>
              {loading ? "Loading sessions..." : "No sessions found."}
            </div>
          ) : (
            rows.map((row) => (
              <SessionRow
                key={row.key}
                row={row}
                disabled={isDisabled}
                onPatch={handlePatch}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
