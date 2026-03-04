"use client";

import { useState, useCallback, useEffect } from "react";
import type { ConfigSnapshot } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

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
  tabs: {
    display: "flex",
    gap: 4,
    marginBottom: 16,
    borderBottom: "1px solid var(--border)",
    paddingBottom: 8,
  } as React.CSSProperties,
  tab: {
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 500,
    borderWidth: 0,
    borderRadius: "var(--radius-md)",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    transition: "background 0.15s, color 0.15s",
  } as React.CSSProperties,
  tabActive: {
    background: "var(--secondary)",
    color: "var(--text-strong)",
  } as React.CSSProperties,
  textarea: {
    width: "100%",
    minHeight: 400,
    padding: 12,
    fontSize: 13,
    fontFamily: "var(--mono)",
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    color: "var(--text)",
    resize: "vertical" as const,
    lineHeight: 1.5,
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginBottom: 12,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
  } as React.CSSProperties,
  calloutWarning: {
    background: "rgba(245, 158, 11, 0.1)",
    color: "var(--warn)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--warn)",
  } as React.CSSProperties,
  calloutSuccess: {
    background: "var(--ok-subtle)",
    color: "var(--ok)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--ok)",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  statusBar: {
    display: "flex",
    gap: 16,
    alignItems: "center",
    marginTop: 12,
    fontSize: 13,
    color: "var(--muted)",
  } as React.CSSProperties,
  issueList: {
    margin: 0,
    padding: "0 0 0 20px",
    fontSize: 13,
  } as React.CSSProperties,
};

// ============================================
// Main Config Page
// ============================================

type FormMode = "form" | "raw";

export default function ConfigPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [raw, setRaw] = useState("");
  const [originalRaw, setOriginalRaw] = useState("");
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);

  const [formMode, setFormMode] = useState<FormMode>("raw");

  const hasChanges = raw !== originalRaw;

  const loadConfig = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await request<ConfigSnapshot>("config.get", {});
      const configRaw = res.raw ?? "";
      setRaw(configRaw);
      setOriginalRaw(configRaw);
      setConfigPath(res.path ?? null);
      setValid(res.valid ?? null);
      setIssues(res.issues ?? []);
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
    if (state !== "connected" || !hasChanges) {
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await request<ConfigSnapshot>("config.set", { raw });
      setOriginalRaw(raw);
      setValid(res.valid ?? null);
      setIssues(res.issues ?? []);
      setSuccess("Configuration saved successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  }, [state, request, raw, hasChanges]);

  const handleApply = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setApplying(true);
    setError(null);
    setSuccess(null);

    try {
      await request("config.apply", {});
      setSuccess("Configuration applied successfully. Gateway will reload.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply config");
    } finally {
      setApplying(false);
    }
  }, [state, request]);

  const handleRevert = useCallback(() => {
    setRaw(originalRaw);
    setSuccess(null);
    setError(null);
  }, [originalRaw]);

  const isDisabled = loading || state !== "connected";
  const isBusy = saving || applying;

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
          Configuration
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Gateway configuration and settings.
        </p>
      </div>

      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Config Editor</div>
            <div style={styles.cardSub}>
              {state === "connected"
                ? configPath
                  ? `Editing: ${configPath}`
                  : "Connected"
                : state === "connecting"
                  ? "Connecting to gateway..."
                  : "Not connected"}
            </div>
          </div>
          <div style={styles.btnGroup}>
            <button style={styles.btn} disabled={isDisabled} onClick={loadConfig}>
              {loading ? "Loading…" : "Reload"}
            </button>
            <button style={styles.btn} disabled={isDisabled || !hasChanges} onClick={handleRevert}>
              Revert
            </button>
            <button
              style={{ ...styles.btn, ...styles.btnPrimary }}
              disabled={isDisabled || !hasChanges || isBusy}
              onClick={handleSave}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              style={{ ...styles.btn, ...styles.btnDanger }}
              disabled={isDisabled || isBusy}
              onClick={handleApply}
            >
              {applying ? "Applying…" : "Apply & Reload"}
            </button>
          </div>
        </div>

        <div style={styles.tabs}>
          <button
            style={{
              ...styles.tab,
              ...(formMode === "form" ? styles.tabActive : {}),
            }}
            onClick={() => setFormMode("form")}
          >
            Form
          </button>
          <button
            style={{
              ...styles.tab,
              ...(formMode === "raw" ? styles.tabActive : {}),
            }}
            onClick={() => setFormMode("raw")}
          >
            Raw YAML
          </button>
        </div>

        {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

        {success && <div style={{ ...styles.callout, ...styles.calloutSuccess }}>{success}</div>}

        {issues.length > 0 && (
          <div style={{ ...styles.callout, ...styles.calloutWarning }}>
            <strong>Configuration issues:</strong>
            <ul style={styles.issueList}>
              {issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.path}</code>: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {formMode === "raw" ? (
          <textarea
            style={styles.textarea}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            disabled={isDisabled || isBusy}
            placeholder="# OpenClaw configuration (YAML)"
            spellCheck={false}
          />
        ) : (
          <div
            style={{
              ...styles.muted,
              padding: 40,
              textAlign: "center",
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: "var(--border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            Form editor coming soon. Use Raw YAML mode for now.
          </div>
        )}

        <div style={styles.statusBar}>
          <span>
            Valid:{" "}
            <span
              style={{
                color:
                  valid === true ? "var(--ok)" : valid === false ? "var(--danger)" : "var(--muted)",
              }}
            >
              {valid === true ? "Yes" : valid === false ? "No" : "Unknown"}
            </span>
          </span>
          {hasChanges && <span style={{ color: "var(--warn)" }}>• Unsaved changes</span>}
        </div>
      </div>
    </div>
  );
}
