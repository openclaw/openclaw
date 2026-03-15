"use client";

import { useState, useCallback, useEffect } from "react";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Types
// ============================================

type MemoryStatus = {
  agentId: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
  backend: "builtin" | "qmd";
  sources: Array<"memory" | "sessions">;
  index?: {
    chunks: number;
    files: number;
    cacheEntries: number;
    lastSync?: string;
    dirty: boolean;
    vectorAvailable: boolean;
    ftsAvailable: boolean;
  };
  providerStatus?: {
    available: boolean;
    apiKeyAvailable: boolean;
    baseUrl?: string;
    error?: string;
  };
  config?: {
    chunkTokens: number;
    chunkOverlap: number;
    watchEnabled: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    batchEnabled: boolean;
    cacheEnabled: boolean;
    hybridEnabled: boolean;
    mmrEnabled: boolean;
    temporalDecayEnabled: boolean;
  };
};

type MemoryChunk = {
  chunkId: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding?: number[];
  indexedAt: number;
};

type SearchHit = {
  chunkId: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  ageInDays?: number;
};

// ============================================
// Styles
// ============================================

const s = {
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
    marginBottom: 20,
  } as React.CSSProperties,
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: "0 0 4px 0",
  } as React.CSSProperties,
  cardSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginBottom: 20,
  } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 14,
    marginBottom: 20,
  } as React.CSSProperties,
  statBox: {
    background: "var(--secondary)",
    borderRadius: "var(--radius-md)",
    padding: "12px 16px",
  } as React.CSSProperties,
  statLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  } as React.CSSProperties,
  statValue: {
    fontSize: 20,
    fontWeight: 700,
    marginTop: 6,
    color: "var(--text-strong)",
  } as React.CSSProperties,
  badge: (variant: "ok" | "warn" | "danger" | "info"): React.CSSProperties => ({
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    background:
      variant === "ok"
        ? "var(--ok-subtle)"
        : variant === "warn"
          ? "rgba(245, 158, 11, 0.15)"
          : variant === "danger"
            ? "var(--danger-subtle)"
            : "var(--info-subtle)",
    color:
      variant === "ok"
        ? "var(--ok)"
        : variant === "warn"
          ? "var(--warn)"
          : variant === "danger"
            ? "var(--danger)"
            : "var(--info)",
  }),
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "10px 12px",
    borderBottom: "2px solid var(--border)",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.02em",
  } as React.CSSProperties,
  td: {
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
    verticalAlign: "top" as const,
  } as React.CSSProperties,
  input: {
    width: "100%",
    padding: "9px 12px",
    fontSize: 14,
    fontFamily: "var(--mono)",
    background: "var(--input-bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  btn: {
    height: 36,
    padding: "0 18px",
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
  btnPrimary: {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    color: "var(--accent-foreground)",
  } as React.CSSProperties,
  btnDanger: {
    background: "var(--danger-subtle)",
    borderColor: "var(--danger)",
    color: "var(--danger)",
  } as React.CSSProperties,
  code: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    background: "var(--code-bg)",
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
  } as React.CSSProperties,
  pre: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    background: "var(--code-bg)",
    padding: 12,
    borderRadius: "var(--radius-md)",
    overflow: "auto" as const,
    margin: 0,
  } as React.CSSProperties,
  callout: (variant: "danger" | "warn" | "ok" | "info"): React.CSSProperties => ({
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginBottom: 16,
    background:
      variant === "danger"
        ? "var(--danger-subtle)"
        : variant === "warn"
          ? "rgba(245, 158, 11, 0.1)"
          : variant === "ok"
            ? "var(--ok-subtle)"
            : "var(--info-subtle)",
    color:
      variant === "danger"
        ? "var(--danger)"
        : variant === "warn"
          ? "var(--warn)"
          : variant === "ok"
            ? "var(--ok)"
            : "var(--info)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor:
      variant === "danger"
        ? "var(--danger)"
        : variant === "warn"
          ? "var(--warn)"
          : variant === "ok"
            ? "var(--ok)"
            : "var(--info)",
  }),
  progress: {
    width: "100%",
    height: 6,
    background: "var(--secondary)",
    borderRadius: "var(--radius-sm)",
    overflow: "hidden",
  } as React.CSSProperties,
  progressBar: (percent: number): React.CSSProperties => ({
    height: "100%",
    width: `${percent}%`,
    background: "var(--accent)",
    transition: "width 0.3s",
  }),
};

// ============================================
// Main Component
// ============================================

export default function MemoryDebugPage() {
  const { request, state: gatewayState } = useGateway();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [chunks, setChunks] = useState<MemoryChunk[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"status" | "chunks" | "search" | "config">("status");

  // Fetch memory status on mount
  useEffect(() => {
    void fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await request<MemoryStatus>("memory.status", { deep: true });
      setStatus(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch memory status";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  const fetchChunks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await request<{ chunks: MemoryChunk[] }>("memory.chunks.list", { limit: 100 });
      setChunks(result.chunks);
      setActiveTab("chunks");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch chunks";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      return;
    }

    try {
      setSearching(true);
      setError(null);
      const result = await request<{ hits: SearchHit[] }>("memory.search", {
        query: searchQuery,
        limit: 20,
        includeScores: true,
      });
      setSearchResults(result.hits);
      setActiveTab("search");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Search failed";
      setError(message);
    } finally {
      setSearching(false);
    }
  }, [request, searchQuery]);

  const triggerSync = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await request("memory.sync", { force: true });
      await fetchStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Sync failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [request, fetchStatus]);

  const clearCache = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await request("memory.cache.clear", {});
      await fetchStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Clear cache failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [request, fetchStatus]);

  const reindex = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await request("memory.index", { rebuild: true });
      await fetchStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Reindex failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [request, fetchStatus]);

  const formatNumber = (num?: number) => {
    if (num === undefined || num === null) {
      return "—";
    }
    return num.toLocaleString();
  };

  const formatTimeAgo = (timestamp?: number) => {
    if (!timestamp) {
      return "Never";
    }
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) {
      return "Just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  // ============================================
  // Render
  // ============================================

  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      {/* Header */}
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
          Memory Debug
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Embedding database status, chunks, and search testing.
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={s.callout("danger")}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Gateway Connection Warning */}
      {gatewayState === "disconnected" && (
        <div style={s.callout("warn")}>
          <strong>Warning:</strong> Gateway disconnected. Connect to see live data.
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 20,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 1,
        }}
      >
        {[
          { id: "status", label: "Status" },
          { id: "chunks", label: "Chunks" },
          { id: "search", label: "Search" },
          { id: "config", label: "Config" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              background: activeTab === tab.id ? "var(--accent)" : "transparent",
              color: activeTab === tab.id ? "var(--accent-foreground)" : "var(--text)",
              border: "none",
              borderRadius: "var(--radius-md) var(--radius-md) 0 0",
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Status Tab */}
      {activeTab === "status" && (
        <>
          {/* Stats Grid */}
          <div style={s.grid}>
            <div style={s.statBox}>
              <div style={s.statLabel}>Chunks</div>
              <div style={s.statValue}>{formatNumber(status?.index?.chunks)}</div>
            </div>
            <div style={s.statBox}>
              <div style={s.statLabel}>Files Indexed</div>
              <div style={s.statValue}>{formatNumber(status?.index?.files)}</div>
            </div>
            <div style={s.statBox}>
              <div style={s.statLabel}>Cache Entries</div>
              <div style={s.statValue}>{formatNumber(status?.index?.cacheEntries)}</div>
            </div>
            <div style={s.statBox}>
              <div style={s.statLabel}>Last Sync</div>
              <div style={{ ...s.statValue, fontSize: 14 }}>
                {formatTimeAgo(
                  status?.index?.lastSync ? new Date(status.index.lastSync).getTime() : undefined,
                )}
              </div>
            </div>
          </div>

          {/* Status Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {/* Provider Status */}
            <div style={s.card}>
              <h3 style={s.cardTitle}>Embedding Provider</h3>
              <p style={s.cardSub}>
                {status?.provider ? `${status.provider} / ${status.model}` : "Not configured"}
              </p>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: status?.providerStatus?.available ? "var(--ok)" : "var(--danger)",
                    }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {status?.providerStatus?.available ? "Available" : "Unavailable"}
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: status?.providerStatus?.apiKeyAvailable
                        ? "var(--ok)"
                        : "var(--danger)",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>
                    API Key: {status?.providerStatus?.apiKeyAvailable ? "OK" : "Missing"}
                  </span>
                </div>

                {status?.providerStatus?.error && (
                  <pre style={s.pre}>{status.providerStatus.error}</pre>
                )}
              </div>

              <div style={{ marginTop: 16 }}>
                <span style={s.badge(status?.enabled ? "ok" : "danger")}>
                  {status?.enabled ? "Enabled" : "Disabled"}
                </span>
                <span style={{ marginLeft: 8 }} />
                <span style={s.badge("info")}>{status?.backend || "builtin"}</span>
              </div>
            </div>

            {/* Index Status */}
            <div style={s.card}>
              <h3 style={s.cardTitle}>Index Health</h3>
              <p style={s.cardSub}>SQLite database status</p>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: status?.index?.vectorAvailable ? "var(--ok)" : "var(--warn)",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>Vector Search (sqlite-vec)</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: status?.index?.ftsAvailable ? "var(--ok)" : "var(--warn)",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>Full-Text Search (BM25)</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: !status?.index?.dirty ? "var(--ok)" : "var(--warn)",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>
                    Sync Status: {status?.index?.dirty ? "Pending" : "Up to date"}
                  </span>
                </div>
              </div>

              {status?.index?.dirty && (
                <div style={s.callout("warn")}>Index is dirty. Changes pending sync.</div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ ...s.card, marginTop: 20 }}>
            <h3 style={s.cardTitle}>Actions</h3>
            <p style={s.cardSub}>Manual operations for debugging</p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={fetchStatus}
                disabled={loading}
                style={{ ...s.btn, ...(loading ? { opacity: 0.5 } : {}) }}
              >
                Refresh Status
              </button>

              <button
                onClick={triggerSync}
                disabled={loading}
                style={{ ...s.btn, ...s.btnPrimary, ...(loading ? { opacity: 0.5 } : {}) }}
              >
                Force Sync
              </button>

              <button
                onClick={fetchChunks}
                disabled={loading}
                style={{ ...s.btn, ...(loading ? { opacity: 0.5 } : {}) }}
              >
                List Chunks
              </button>

              <button
                onClick={clearCache}
                disabled={loading}
                style={{ ...s.btn, ...(loading ? { opacity: 0.5 } : {}) }}
              >
                Clear Cache
              </button>

              <button
                onClick={reindex}
                disabled={loading}
                style={{ ...s.btn, ...s.btnDanger, ...(loading ? { opacity: 0.5 } : {}) }}
              >
                Reindex All
              </button>
            </div>
          </div>
        </>
      )}

      {/* Chunks Tab */}
      {activeTab === "chunks" && (
        <div style={s.card}>
          <h3 style={s.cardTitle}>Indexed Chunks</h3>
          <p style={s.cardSub}>Showing up to 100 most recent chunks</p>

          {chunks.length === 0 ? (
            <div style={s.callout("info")}>
              No chunks found. Click &quot;List Chunks&quot; to load or ensure memory files exist.
            </div>
          ) : (
            <div style={{ overflow: "auto" }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>File</th>
                    <th style={s.th}>Lines</th>
                    <th style={s.th}>Preview</th>
                    <th style={s.th}>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {chunks.map((chunk) => (
                    <tr key={chunk.chunkId}>
                      <td style={s.td}>
                        <code style={s.code}>{chunk.file}</code>
                      </td>
                      <td style={s.td}>
                        {chunk.startLine}–{chunk.endLine}
                      </td>
                      <td style={{ ...s.td, maxWidth: 400 }}>
                        <div
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--muted)",
                          }}
                        >
                          {chunk.text.slice(0, 100)}
                          {chunk.text.length > 100 ? "..." : ""}
                        </div>
                      </td>
                      <td style={s.td}>
                        <code style={{ ...s.code, fontSize: 10 }}>
                          {chunk.hash.slice(0, 12)}...
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Search Tab */}
      {activeTab === "search" && (
        <>
          {/* Search Input */}
          <div style={s.card}>
            <h3 style={s.cardTitle}>Test Search</h3>
            <p style={s.cardSub}>Query your memory index</p>

            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder="Enter search query..."
                // eslint-disable-next-line react/no-unescaped-entities
                style={{ ...s.input, flex: 1 }}
              />
              <button
                onClick={runSearch}
                disabled={searching || !searchQuery.trim()}
                style={{ ...s.btn, ...s.btnPrimary, ...(searching ? { opacity: 0.5 } : {}) }}
              >
                {searching ? "Searching..." : "Search"}
              </button>
            </div>
          </div>

          {/* Results */}
          {searchResults.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>Results ({searchResults.length})</h3>
              <p style={s.cardSub}>Ranked by relevance score</p>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {searchResults.map((hit, idx) => (
                  <div
                    key={hit.chunkId}
                    style={{
                      padding: 14,
                      background: "var(--secondary)",
                      borderRadius: "var(--radius-md)",
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderColor: idx === 0 ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <div>
                        <code style={s.code}>{hit.file}</code>
                        <span style={{ marginLeft: 8, color: "var(--muted)", fontSize: 12 }}>
                          Lines {hit.startLine}–{hit.endLine}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--accent)",
                        }}
                      >
                        Score: {(hit.score * 100).toFixed(1)}%
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: "var(--text)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {hit.text}
                    </div>

                    {hit.vectorScore !== undefined && hit.bm25Score !== undefined && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 11,
                          color: "var(--muted)",
                        }}
                      >
                        Vector: {(hit.vectorScore * 100).toFixed(1)}% | BM25:{" "}
                        {(hit.bm25Score * 100).toFixed(1)}%
                        {hit.ageInDays !== undefined && ` | Age: ${hit.ageInDays.toFixed(0)}d`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {searchResults.length === 0 && searchQuery && !searching && (
            <div style={s.callout("info")}>No results found for &quot;{searchQuery}&quot;</div>
          )}
        </>
      )}

      {/* Config Tab */}
      {activeTab === "config" && status?.config && (
        <div style={s.card}>
          <h3 style={s.cardTitle}>Memory Configuration</h3>
          <p style={s.cardSub}>Current settings from openclaw.json</p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Chunking</h4>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Tokens per chunk:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{status.config.chunkTokens}</div>
              </div>
              <div>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Overlap:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.chunkOverlap} tokens
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Sync</h4>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Watch enabled:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.watchEnabled ? "Yes" : "No"}
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Debounce:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.watchDebounceMs}ms
                </div>
              </div>
              <div>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Interval:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.intervalMinutes} minutes
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Features</h4>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Batch embedding:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.batchEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Cache:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.cacheEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
              <div>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Hybrid search:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.hybridEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Ranking</h4>
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>MMR diversity:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.mmrEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
              <div>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>Temporal decay:</span>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {status.config.temporalDecayEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
