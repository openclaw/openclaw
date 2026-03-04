"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  AgentsListResult,
  GatewayAgentRow,
  AgentsFilesListResult,
  AgentsFilesGetResult,
  AgentsFilesSetResult,
} from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";
import { ToolsPanel } from "./tools-panel";

// ============================================
// Types
// ============================================

type AgentsPanel = "overview" | "files" | "tools";

// ============================================
// Helpers
// ============================================

function normalizeAgentLabel(agent: GatewayAgentRow): string {
  return agent.identity?.name ?? agent.name ?? agent.id;
}

function resolveAgentEmoji(agent: GatewayAgentRow): string {
  return agent.identity?.emoji ?? "";
}

function agentBadgeText(agentId: string, defaultId: string | null): string | null {
  if (agentId === defaultId) {
    return "default";
  }
  return null;
}

function getFileLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript JSX",
    js: "JavaScript",
    jsx: "JavaScript JSX",
    json: "JSON",
    md: "Markdown",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    sh: "Shell",
    py: "Python",
    txt: "Text",
    env: "ENV",
    css: "CSS",
    html: "HTML",
  };
  return (map[ext] ?? ext.toUpperCase()) || "Plain Text";
}

function formatBytes(bytes?: number): string {
  if (!bytes) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================
// Styles
// ============================================

const styles = {
  layout: {
    display: "grid",
    gridTemplateColumns: "280px 1fr",
    gap: 20,
    minHeight: 500,
  } as React.CSSProperties,
  sidebar: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
  } as React.CSSProperties,
  main: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
  } as React.CSSProperties,
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
    marginBottom: 12,
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
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
  } as React.CSSProperties,
  btnPrimary: {
    height: 28,
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 600,
    borderWidth: 0,
    borderRadius: "var(--radius-md)",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
  } as React.CSSProperties,
  btnDanger: {
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
    borderRadius: "var(--radius-md)",
    background: "transparent",
    color: "var(--danger)",
    cursor: "pointer",
  } as React.CSSProperties,
  agentList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginTop: 12,
  } as React.CSSProperties,
  agentRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left" as const,
    width: "100%",
    transition: "background 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  agentRowActive: {
    background: "var(--bg-hover)",
    borderColor: "var(--border)",
  } as React.CSSProperties,
  avatar: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "var(--accent-subtle)",
    color: "var(--accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 600,
    flexShrink: 0,
  } as React.CSSProperties,
  agentInfo: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  agentTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-strong)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  agentSub: {
    fontSize: 11,
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  pill: {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 9999,
    background: "var(--accent-subtle)",
    color: "var(--accent)",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,
  tabs: {
    display: "flex",
    gap: 4,
    borderBottom: "1px solid var(--border)",
    paddingBottom: 0,
    marginBottom: 0,
  } as React.CSSProperties,
  tab: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    borderWidth: 0,
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    transition: "color 0.15s, border-color 0.15s",
    marginBottom: -1,
  } as React.CSSProperties,
  tabActive: {
    color: "var(--text-strong)",
    borderBottomColor: "var(--accent)",
  } as React.CSSProperties,
  headerCard: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
    display: "flex",
    alignItems: "center",
    gap: 16,
  } as React.CSSProperties,
  avatarLg: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "var(--accent-subtle)",
    color: "var(--accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    fontWeight: 600,
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
  calloutOk: {
    background: "var(--ok-subtle, rgba(34,197,94,0.1))",
    color: "var(--ok)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--ok)",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  overviewGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
    marginTop: 16,
  } as React.CSSProperties,
  statCard: {
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    padding: 16,
  } as React.CSSProperties,
  statLabel: {
    fontSize: 12,
    color: "var(--muted)",
    marginBottom: 4,
  } as React.CSSProperties,
  statValue: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
  } as React.CSSProperties,
};

const TABS: Array<{ id: AgentsPanel; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "tools", label: "Tools" },
];

// ============================================
// File Editor Component
// ============================================

type FileEditorProps = {
  agentId: string;
  fileName: string;
  filePath: string;
  onClose: () => void;
  onSaved: () => void;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

function FileEditor({ agentId, fileName, filePath, onClose, onSaved, request }: FileEditorProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [fileEntry, setFileEntry] = useState<AgentsFilesGetResult["file"] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filename = fileName;
  const isDirty = content !== originalContent;

  useEffect(() => {
    async function loadFile() {
      setLoading(true);
      setError(null);
      try {
        const res = await request<AgentsFilesGetResult>("agents.files.get", {
          agentId,
          name: fileName,
        });
        const text = res.file.content ?? "";
        setContent(text);
        setOriginalContent(text);
        setFileEntry(res.file);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setLoading(false);
      }
    }
    void loadFile();
  }, [agentId, filePath, request]);

  // Focus textarea after load
  useEffect(() => {
    if (!loading && !error) {
      textareaRef.current?.focus();
    }
  }, [loading, error]);

  // Keyboard shortcut: Cmd/Ctrl+S to save
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) {
          void handleSave();
        }
      }
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, saving, content]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      await request<AgentsFilesSetResult>("agents.files.set", {
        agentId,
        name: fileName,
        content,
      });
      setOriginalContent(content);
      setSaveSuccess(true);
      onSaved();
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
        backdropFilter: "blur(4px)",
        animation: "fadeIn 0.15s ease-out",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 860,
          maxHeight: "90vh",
          background: "var(--card)",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
          animation: "rise 0.2s ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-strong)",
                fontFamily: "var(--mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {filename}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 2,
                fontFamily: "var(--mono)",
              }}
            >
              {filePath}
              {fileEntry && (
                <span style={{ marginLeft: 8 }}>
                  · {getFileLanguage(filename)} ·{" "}
                  {formatBytes(fileEntry.sizeBytes ?? fileEntry.size)}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isDirty && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
                title="Unsaved changes"
              />
            )}
            <button
              style={styles.btn}
              onClick={() => {
                setContent(originalContent);
                setSaveSuccess(false);
                setError(null);
              }}
              disabled={!isDirty || saving}
              title="Discard changes"
            >
              Discard
            </button>
            <button
              style={{
                ...styles.btnPrimary,
                opacity: !isDirty || saving ? 0.5 : 1,
              }}
              onClick={handleSave}
              disabled={!isDirty || saving}
              title="Save (⌘S)"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              style={{
                ...styles.btn,
                padding: "0 10px",
              }}
              onClick={onClose}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Status bar */}
        {(error || saveSuccess) && (
          <div
            style={{
              padding: "6px 16px",
              fontSize: 12,
              borderBottom: "1px solid var(--border)",
              ...(error
                ? { background: "var(--danger-subtle)", color: "var(--danger)" }
                : {
                    background: "var(--ok-subtle, rgba(34,197,94,0.1))",
                    color: "var(--ok)",
                  }),
            }}
          >
            {error ?? "✓ File saved successfully"}
          </div>
        )}

        {/* Editor body */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--muted)",
                fontSize: 13,
                minHeight: 300,
              }}
            >
              Loading file...
            </div>
          ) : error && !content ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--danger)",
                fontSize: 13,
                minHeight: 300,
              }}
            >
              {error}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setSaveSuccess(false);
              }}
              spellCheck={false}
              style={{
                width: "100%",
                height: "100%",
                minHeight: 420,
                maxHeight: "calc(90vh - 120px)",
                resize: "none",
                background: "var(--bg)",
                color: "var(--text)",
                borderWidth: 0,
                outline: "none",
                fontFamily:
                  "var(--mono, 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace)",
                fontSize: 13,
                lineHeight: 1.65,
                padding: "16px 20px",
                tabSize: 2,
                boxSizing: "border-box",
              }}
              onKeyDown={(e) => {
                // Tab key → insert 2 spaces
                if (e.key === "Tab") {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  const newValue = content.substring(0, start) + "  " + content.substring(end);
                  setContent(newValue);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 2;
                  });
                }
              }}
            />
          )}
        </div>

        {/* Footer hint */}
        {!loading && (
          <div
            style={{
              padding: "6px 16px",
              borderTop: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--muted)",
              display: "flex",
              justifyContent: "space-between",
              flexShrink: 0,
            }}
          >
            <span>Tab inserts 2 spaces · ⌘S to save · Esc to close</span>
            {isDirty && <span style={{ color: "var(--accent)" }}>● Unsaved changes</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Files Panel Component
// ============================================

type FilesPanelProps = {
  agentId: string;
  filesLoading: boolean;
  filesResult: AgentsFilesListResult | null;
  onRefresh: () => void;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

type OpenFileState = { name: string; path: string };

function FilesPanel({ agentId, filesLoading, filesResult, onRefresh, request }: FilesPanelProps) {
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);

  const files = filesResult?.files ?? [];

  return (
    <div>
      <div style={{ ...styles.cardHeader, marginBottom: 16 }}>
        <div>
          <div style={styles.cardTitle}>Agent Files</div>
          <div style={styles.cardSub}>
            Workspace files for this agent. Click a file to view or edit.
          </div>
        </div>
        <button style={styles.btn} onClick={onRefresh} disabled={filesLoading}>
          {filesLoading ? "..." : "Refresh"}
        </button>
      </div>

      {filesLoading ? (
        <div style={{ ...styles.muted, marginTop: 16 }}>Loading files...</div>
      ) : files.length === 0 ? (
        <div style={{ ...styles.muted, marginTop: 16 }}>No files found.</div>
      ) : (
        <div
          style={{
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          {files.map((file, idx) => {
            const filename = file.name ?? file.path.split("/").pop() ?? file.path;
            const lang = getFileLanguage(filename);
            return (
              <button
                key={file.path}
                onClick={() =>
                  setOpenFile({
                    name: file.name ?? file.path.split("/").pop() ?? file.path,
                    path: file.path,
                  })
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "10px 14px",
                  background: "transparent",
                  borderWidth: 0,
                  borderBottom: idx < files.length - 1 ? "1px solid var(--border)" : "none",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                {/* File icon */}
                <span
                  style={{
                    fontSize: 16,
                    flexShrink: 0,
                    width: 24,
                    textAlign: "center",
                    lineHeight: 1,
                  }}
                >
                  📄
                </span>

                {/* File info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--text-strong)",
                      fontFamily: "var(--mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {filename}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--muted)",
                      fontFamily: "var(--mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      marginTop: 2,
                    }}
                  >
                    {file.path}
                  </div>
                </div>

                {/* Metadata */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      padding: "2px 8px",
                      fontSize: 10,
                      fontWeight: 600,
                      borderRadius: 9999,
                      background: "var(--secondary)",
                      color: "var(--muted)",
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderColor: "var(--border)",
                    }}
                  >
                    {lang}
                  </span>
                  {(file.sizeBytes ?? file.size) !== undefined && (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {formatBytes(file.sizeBytes ?? file.size)}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--accent)",
                      flexShrink: 0,
                    }}
                  >
                    Edit →
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* File Editor Modal */}
      {openFile && (
        <FileEditor
          agentId={agentId}
          fileName={openFile.name}
          filePath={openFile.path}
          onClose={() => setOpenFile(null)}
          onSaved={onRefresh}
          request={request}
        />
      )}
    </div>
  );
}

// ============================================
// Main Agents Page
// ============================================

export default function AgentsPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentsList, setAgentsList] = useState<AgentsListResult | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<AgentsPanel>("overview");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesResult, setFilesResult] = useState<AgentsFilesListResult | null>(null);

  const loadAgents = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await request<AgentsListResult>("agents.list", {});
      setAgentsList(res);
      if (!selectedAgentId && res.agents.length > 0) {
        setSelectedAgentId(res.defaultId ?? res.agents[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, [state, request, selectedAgentId]);

  const loadFiles = useCallback(
    async (agentId: string) => {
      if (state !== "connected") {
        return;
      }

      setFilesLoading(true);
      try {
        const res = await request<AgentsFilesListResult>("agents.files.list", {
          agentId,
        });
        setFilesResult(res);
      } catch {
        setFilesResult(null);
      } finally {
        setFilesLoading(false);
      }
    },
    [state, request],
  );

  useEffect(() => {
    if (state === "connected") {
      void loadAgents();
    }
  }, [state, loadAgents]);

  useEffect(() => {
    if (selectedAgentId && activePanel === "files") {
      void loadFiles(selectedAgentId);
    }
  }, [selectedAgentId, activePanel, loadFiles]);

  const agents = agentsList?.agents ?? [];
  const defaultId = agentsList?.defaultId ?? null;
  const selectedAgent = selectedAgentId
    ? (agents.find((a) => a.id === selectedAgentId) ?? null)
    : null;

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
          Agents
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Manage AI agents and their configurations.
        </p>
      </div>

      <div style={styles.layout}>
        {/* Sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Agents</div>
              <div style={styles.cardSub}>{agents.length} configured</div>
            </div>
            <button style={styles.btn} disabled={isDisabled} onClick={loadAgents}>
              {loading ? "..." : "Refresh"}
            </button>
          </div>

          {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

          <div style={styles.agentList}>
            {agents.length === 0 ? (
              <div style={styles.muted}>{loading ? "Loading agents..." : "No agents found."}</div>
            ) : (
              agents.map((agent) => {
                const isActive = selectedAgentId === agent.id;
                const badge = agentBadgeText(agent.id, defaultId);
                const emoji = resolveAgentEmoji(agent);
                const label = normalizeAgentLabel(agent);

                return (
                  <button
                    key={agent.id}
                    type="button"
                    style={{
                      ...styles.agentRow,
                      ...(isActive ? styles.agentRowActive : {}),
                    }}
                    onClick={() => setSelectedAgentId(agent.id)}
                  >
                    <div style={styles.avatar}>{emoji || label.slice(0, 1).toUpperCase()}</div>
                    <div style={styles.agentInfo}>
                      <div style={styles.agentTitle}>{label}</div>
                      <div style={styles.agentSub}>{agent.id}</div>
                    </div>
                    {badge && <span style={styles.pill}>{badge}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Main Content */}
        <div style={styles.main}>
          {!selectedAgent ? (
            <div style={styles.card}>
              <div style={styles.cardTitle}>Select an agent</div>
              <div style={styles.cardSub}>Pick an agent to inspect its workspace and tools.</div>
            </div>
          ) : (
            <>
              {/* Agent Header */}
              <div style={styles.headerCard}>
                <div style={styles.avatarLg}>
                  {resolveAgentEmoji(selectedAgent) ||
                    normalizeAgentLabel(selectedAgent).slice(0, 1).toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={styles.cardTitle}>{normalizeAgentLabel(selectedAgent)}</div>
                  <div style={styles.cardSub}>
                    {selectedAgent.identity?.theme ?? "Agent workspace and routing."}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...styles.muted, fontFamily: "var(--mono)" }}>
                    {selectedAgent.id}
                  </span>
                  {agentBadgeText(selectedAgent.id, defaultId) && (
                    <span style={styles.pill}>{agentBadgeText(selectedAgent.id, defaultId)}</span>
                  )}
                </div>
              </div>

              {/* Tabs */}
              <div style={styles.tabs}>
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    style={{
                      ...styles.tab,
                      ...(activePanel === tab.id ? styles.tabActive : {}),
                    }}
                    onClick={() => setActivePanel(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div style={styles.card}>
                {activePanel === "overview" && (
                  <div>
                    <div style={styles.cardTitle}>Agent Overview</div>
                    <div style={styles.cardSub}>Basic information about this agent.</div>
                    <div style={styles.overviewGrid}>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Agent ID</div>
                        <div
                          style={{
                            ...styles.statValue,
                            fontFamily: "var(--mono)",
                            fontSize: 13,
                          }}
                        >
                          {selectedAgent.id}
                        </div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Display Name</div>
                        <div style={styles.statValue}>{normalizeAgentLabel(selectedAgent)}</div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Status</div>
                        <div style={{ ...styles.statValue, color: "var(--ok)" }}>Active</div>
                      </div>
                      <div style={styles.statCard}>
                        <div style={styles.statLabel}>Role</div>
                        <div style={styles.statValue}>
                          {selectedAgent.id === defaultId ? "Default" : "Agent"}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activePanel === "files" && selectedAgentId && (
                  <FilesPanel
                    agentId={selectedAgentId}
                    filesLoading={filesLoading}
                    filesResult={filesResult}
                    onRefresh={() => loadFiles(selectedAgentId)}
                    request={request}
                  />
                )}

                {activePanel === "tools" && selectedAgentId && (
                  <ToolsPanel agentId={selectedAgentId} request={request} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
