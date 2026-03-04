"use client";

import { useState } from "react";
import { useSettings } from "@/lib/use-settings";

export default function SettingsPage() {
  const { settings, updateSettings, isLoaded } = useSettings();
  const [formUrl, setFormUrl] = useState<string | null>(null);
  const [formToken, setFormToken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Use form state if set, otherwise use stored settings
  const gatewayUrl = formUrl ?? settings.gatewayUrl;
  const token = formToken ?? settings.token;

  const handleSave = () => {
    updateSettings({ gatewayUrl, token });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    const proto =
      typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
    const defaultUrl = typeof window !== "undefined" ? `${proto}://${window.location.host}` : "";
    setFormUrl(defaultUrl);
    setFormToken("");
  };

  if (!isLoaded) {
    return <div style={{ padding: 20, color: "var(--muted)" }}>Loading settings...</div>;
  }

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
          Settings
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Configure gateway connection and UI preferences.
        </p>
      </div>

      <div
        style={{
          background: "var(--card)",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 20,
          marginBottom: 20,
        }}
      >
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "var(--text-strong)",
            margin: "0 0 16px 0",
          }}
        >
          Gateway Connection
        </h2>

        <div style={{ marginBottom: 16 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text)",
              marginBottom: 6,
            }}
          >
            Gateway URL
          </label>
          <input
            type="text"
            value={gatewayUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder="ws://localhost:18789 or wss://your-gateway.example.com"
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: "var(--mono)",
              background: "var(--input-bg)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
          <p
            style={{
              fontSize: 12,
              color: "var(--muted)",
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            WebSocket URL for the OpenClaw gateway. Use <code>ws://</code> for local development or{" "}
            <code>wss://</code> for secure connections.
          </p>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text)",
              marginBottom: 6,
            }}
          >
            Token (optional)
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setFormToken(e.target.value)}
            placeholder="Gateway authentication token"
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: "var(--mono)",
              background: "var(--input-bg)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
          <p
            style={{
              fontSize: 12,
              color: "var(--muted)",
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            Authentication token if your gateway requires it.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button
            onClick={handleSave}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 500,
              background: "var(--accent)",
              color: "#fff",
              borderWidth: 0,
              borderRadius: "var(--radius)",
              cursor: "pointer",
            }}
          >
            {saved ? "✓ Saved" : "Save"}
          </button>
          <button
            onClick={handleReset}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 500,
              background: "transparent",
              color: "var(--muted)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
            }}
          >
            Reset to Default
          </button>
        </div>
      </div>

      <div
        style={{
          background: "var(--card)",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 20,
        }}
      >
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "var(--text-strong)",
            margin: "0 0 16px 0",
          }}
        >
          Connection Status
        </h2>
        <div style={{ fontSize: 14, color: "var(--muted)" }}>
          <p style={{ margin: "0 0 8px 0" }}>
            <strong style={{ color: "var(--text)" }}>Current URL:</strong>{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              {settings.gatewayUrl || "(not configured)"}
            </code>
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: "var(--text)" }}>Token:</strong>{" "}
            {settings.token ? "••••••••" : "(none)"}
          </p>
        </div>
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
            💡 <strong>Tip:</strong> For local development, run{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              pnpm gateway:dev
            </code>{" "}
            and use{" "}
            <code
              style={{
                fontFamily: "var(--mono)",
                background: "var(--bg)",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              ws://localhost:18789
            </code>
          </p>
        </div>
      </div>
    </div>
  );
}
