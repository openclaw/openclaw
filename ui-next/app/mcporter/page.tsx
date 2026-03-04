"use client";

import { useState, useCallback, useEffect } from "react";
import type { ConfigSnapshot } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Types
// ============================================

type McporterConfig = {
  enabled?: boolean;
  serverName?: string;
  startDaemon?: boolean;
};

type QmdConfig = {
  mcporter?: McporterConfig;
};

type MemoryConfig = {
  qmd?: QmdConfig;
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
  field: {
    marginBottom: 20,
  } as React.CSSProperties,
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text)",
    marginBottom: 6,
  } as React.CSSProperties,
  hint: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 5,
    lineHeight: 1.5,
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
    boxSizing: "border-box",
  } as React.CSSProperties,

  toggleTrack: (on: boolean): React.CSSProperties => ({
    position: "relative",
    width: 36,
    height: 20,
    borderRadius: 10,
    background: on ? "var(--accent)" : "var(--secondary)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: on ? "var(--accent)" : "var(--border)",
    transition: "background 0.2s, border-color 0.2s",
    flexShrink: 0,
    cursor: "pointer",
  }),
  toggleThumb: (on: boolean): React.CSSProperties => ({
    position: "absolute",
    top: 2,
    left: on ? 16 : 2,
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
    transition: "left 0.2s",
  }),
  btnGroup: {
    display: "flex",
    gap: 10,
    marginTop: 24,
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
  callout: (variant: "danger" | "warn" | "ok"): React.CSSProperties => ({
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginBottom: 16,
    background:
      variant === "danger"
        ? "var(--danger-subtle)"
        : variant === "warn"
          ? "rgba(245, 158, 11, 0.1)"
          : "var(--ok-subtle)",
    color:
      variant === "danger" ? "var(--danger)" : variant === "warn" ? "var(--warn)" : "var(--ok)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor:
      variant === "danger" ? "var(--danger)" : variant === "warn" ? "var(--warn)" : "var(--ok)",
  }),
  divider: {
    borderTop: "1px solid var(--border)",
    margin: "20px 0",
  } as React.CSSProperties,
  statusDot: (ok: boolean): React.CSSProperties => ({
    display: "inline-block",
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: ok ? "var(--ok)" : "var(--muted)",
    marginRight: 6,
    flexShrink: 0,
  }),

  badge: (variant: "ok" | "warn" | "neutral"): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    background:
      variant === "ok"
        ? "var(--ok-subtle)"
        : variant === "warn"
          ? "rgba(245,158,11,0.12)"
          : "var(--secondary)",
    color: variant === "ok" ? "var(--ok)" : variant === "warn" ? "var(--warn)" : "var(--muted)",
  }),
};

// ============================================
// Toggle component
// ============================================

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...s.toggleTrack(checked),
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        borderWidth: 0,
      }}
    >
      <span style={s.toggleThumb(checked)} />
    </button>
  );
}

// ============================================
// Extract mcporter config from full config object
// ============================================

function extractMcporterConfig(config: Record<string, unknown> | null | undefined): McporterConfig {
  const memory = config?.memory as MemoryConfig | undefined;
  const mcporter = memory?.qmd?.mcporter;
  return {
    enabled: mcporter?.enabled ?? false,
    serverName: mcporter?.serverName ?? "qmd",
    startDaemon: mcporter?.startDaemon ?? true,
  };
}

// ============================================
// Build patch object for config.patch
// ============================================

function buildMcporterPatch(cfg: McporterConfig): string {
  return JSON.stringify({
    memory: {
      qmd: {
        mcporter: {
          enabled: cfg.enabled,
          serverName: cfg.serverName || "qmd",
          startDaemon: cfg.startDaemon,
        },
      },
    },
  });
}

// ============================================
// Main Page
// ============================================

export default function McporterPage() {
  const { state, request } = useGateway();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Current saved values from gateway
  const [saved, setSavedConfig] = useState<McporterConfig | null>(null);
  // Form draft values
  const [form, setForm] = useState<McporterConfig>({
    enabled: false,
    serverName: "qmd",
    startDaemon: true,
  });
  // The config.patch baseHash
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);

  const isDirty =
    saved !== null &&
    (form.enabled !== (saved.enabled ?? false) ||
      (form.serverName ?? "qmd") !== (saved.serverName ?? "qmd") ||
      form.startDaemon !== (saved.startDaemon ?? true));

  const loadConfig = useCallback(async () => {
    if (state !== "connected") {
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await request<ConfigSnapshot>("config.get", {});
      const parsed = res.config;
      const mc = extractMcporterConfig(parsed);
      setSavedConfig(mc);
      setForm(mc);
      setBaseHash(res.hash ?? null);
      setConfigPath(res.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, [state, request]);

  useEffect(() => {
    if (state === "connected") {
      void loadConfig();
    }
  }, [state, loadConfig]);

  const handleSave = useCallback(async () => {
    if (state !== "connected" || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const raw = buildMcporterPatch(form);
      await request("config.patch", {
        raw,
        baseHash: baseHash ?? undefined,
      });
      setSavedConfig({ ...form });
      setRestartPending(true);
      setSuccess("MCPorter configuration saved. Gateway will restart to apply changes.");
      // Reload to get fresh hash
      await loadConfig();
      setRestartPending(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [state, saving, form, baseHash, request, loadConfig]);

  const handleDiscard = useCallback(() => {
    if (saved) {
      setForm({ ...saved });
    }
    setError(null);
    setSuccess(null);
  }, [saved]);

  const isDisabled = loading || state !== "connected" || saving;

  return (
    <div style={{ animation: "rise 0.3s ease-out", maxWidth: 680 }}>
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 22 }}>📦</span>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              color: "var(--text-strong)",
              margin: 0,
            }}
          >
            MCPorter
          </h1>
        </div>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0, fontSize: 14 }}>
          Configure{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 13 }}>memory.qmd.mcporter</code> —
          routes QMD queries through the mcporter MCP runtime instead of spawning a new process per
          call.
        </p>
      </div>

      {/* Status card */}
      <div style={s.card}>
        <h2 style={s.cardTitle}>Status</h2>
        <p style={s.cardSub}>Current mcporter configuration loaded from gateway.</p>

        {state !== "connected" ? (
          <div style={{ ...s.callout("warn") }}>
            {state === "connecting" ? "Connecting to gateway…" : "Not connected to gateway"}
          </div>
        ) : loading ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading configuration…</div>
        ) : saved === null ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>No configuration loaded.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span style={s.badge(saved.enabled ? "ok" : "neutral")}>
              <span style={s.statusDot(!!saved.enabled)} />
              {saved.enabled ? "Enabled" : "Disabled"}
            </span>
            <span style={s.badge("neutral")}>
              Server:{" "}
              <code style={{ fontFamily: "var(--mono)", marginLeft: 4 }}>
                {saved.serverName || "qmd"}
              </code>
            </span>
            <span style={s.badge(saved.startDaemon !== false ? "ok" : "warn")}>
              Auto-daemon: {saved.startDaemon !== false ? "on" : "off"}
            </span>
            {configPath && (
              <span style={s.badge("neutral")} title={configPath}>
                📁 {configPath.split("/").pop()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Config form */}
      <div style={s.card}>
        <h2 style={s.cardTitle}>Configuration</h2>
        <p style={s.cardSub}>
          Changes are saved via{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>config.patch</code> and trigger
          a gateway restart.
        </p>

        {error && <div style={s.callout("danger")}>{error}</div>}
        {success && <div style={s.callout("ok")}>{success}</div>}
        {restartPending && !success && (
          <div style={s.callout("warn")}>Gateway is restarting to apply changes…</div>
        )}

        {/* enabled toggle */}
        <div style={s.field}>
          <label style={s.label} htmlFor="mcporter-enabled">
            Enable MCPorter
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle
              checked={!!form.enabled}
              onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={isDisabled}
            />
            <span style={{ fontSize: 13, color: form.enabled ? "var(--text)" : "var(--muted)" }}>
              {form.enabled
                ? "MCPorter active — routes QMD via MCP daemon"
                : "Direct process mode — spawns qmd per request"}
            </span>
          </div>
          <p style={s.hint}>
            When enabled, QMD queries are routed through the mcporter MCP runtime, reducing
            cold-start overhead for larger models. Requires{" "}
            <code style={{ fontFamily: "var(--mono)" }}>mcporter</code> to be installed and a server
            configured with <code style={{ fontFamily: "var(--mono)" }}>lifecycle: keep-alive</code>
            .
          </p>
        </div>

        <div style={s.divider} />

        {/* serverName */}
        <div style={s.field}>
          <label style={s.label} htmlFor="mcporter-server-name">
            Server Name
          </label>
          <input
            id="mcporter-server-name"
            type="text"
            value={form.serverName ?? "qmd"}
            onChange={(e) => setForm((f) => ({ ...f, serverName: e.target.value }))}
            disabled={isDisabled || !form.enabled}
            placeholder="qmd"
            style={{
              ...s.input,
              opacity: !form.enabled ? 0.5 : 1,
            }}
          />
          <p style={s.hint}>
            The mcporter server name used for QMD calls. Defaults to{" "}
            <code style={{ fontFamily: "var(--mono)" }}>qmd</code>. Only change this if your
            mcporter setup uses a custom server name for{" "}
            <code style={{ fontFamily: "var(--mono)" }}>qmd mcp</code> keep-alive.
          </p>
        </div>

        <div style={s.divider} />

        {/* startDaemon toggle */}
        <div style={s.field}>
          <label style={s.label} htmlFor="mcporter-start-daemon">
            Auto-start Daemon
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle
              checked={form.startDaemon !== false}
              onChange={(v) => setForm((f) => ({ ...f, startDaemon: v }))}
              disabled={isDisabled || !form.enabled}
            />
            <span
              style={{
                fontSize: 13,
                color: form.enabled ? "var(--text)" : "var(--muted)",
                opacity: !form.enabled ? 0.5 : 1,
              }}
            >
              {form.startDaemon !== false
                ? "Daemon auto-starts when mcporter mode is active"
                : "Daemon must be managed externally"}
            </span>
          </div>
          <p style={s.hint}>
            Automatically starts the mcporter daemon when mcporter-backed QMD mode is enabled.
            Disable only when process lifecycle is managed externally by your service supervisor.
          </p>
        </div>

        {/* Action buttons */}
        <div style={s.btnGroup}>
          <button
            style={{ ...s.btn, ...s.btnPrimary, opacity: !isDirty || isDisabled ? 0.6 : 1 }}
            disabled={!isDirty || isDisabled}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save & Restart"}
          </button>
          <button
            style={{ ...s.btn, opacity: !isDirty || isDisabled ? 0.5 : 1 }}
            disabled={!isDirty || isDisabled}
            onClick={handleDiscard}
          >
            Discard
          </button>
          <button
            style={{ ...s.btn, opacity: isDisabled ? 0.5 : 1 }}
            disabled={isDisabled}
            onClick={loadConfig}
          >
            {loading ? "Reloading…" : "Reload"}
          </button>
        </div>
      </div>

      {/* Usage guide */}
      <div style={s.card}>
        <h2 style={s.cardTitle}>Setup Guide</h2>
        <p style={s.cardSub}>Steps to get mcporter working with QMD.</p>

        <ol
          style={{
            fontSize: 13,
            color: "var(--text)",
            paddingLeft: 20,
            lineHeight: 2,
            margin: 0,
          }}
        >
          <li>
            Install mcporter:{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              npm install -g mcporter
            </code>
          </li>
          <li>
            Add a qmd server to mcporter config with{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              lifecycle: keep-alive
            </code>
          </li>
          <li>
            Run{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              mcporter daemon start
            </code>{" "}
            (or enable auto-start above)
          </li>
          <li>Enable MCPorter above and save — gateway restarts automatically.</li>
        </ol>

        <div style={{ marginTop: 16, ...s.callout("warn") }}>
          <strong>Note:</strong> MCPorter mode is most beneficial for large models with expensive
          cold starts. For simple local setups, the default direct process mode is simpler and
          equally effective.
        </div>
      </div>
    </div>
  );
}
