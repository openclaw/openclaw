"use client";

import { useSyncExternalStore, useCallback } from "react";

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke="currentColor"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke="currentColor"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke="currentColor"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

type Theme = "dark" | "light" | "system";

// Theme store for SSR-safe localStorage access
let currentTheme: Theme | null = null;
const themeListeners = new Set<() => void>();

function getThemeSnapshot(): Theme {
  if (currentTheme === null && typeof window !== "undefined") {
    const saved = localStorage.getItem("theme") as Theme | null;
    currentTheme = saved ?? "dark";
  }
  return currentTheme ?? "dark";
}

function getThemeServerSnapshot(): Theme {
  return "dark";
}

function subscribeTheme(callback: () => void): () => void {
  themeListeners.add(callback);
  return () => themeListeners.delete(callback);
}

export function Topbar() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);

  const applyTheme = useCallback((t: Theme) => {
    currentTheme = t;
    if (typeof window !== "undefined") {
      localStorage.setItem("theme", t);
      const root = document.documentElement;
      if (t === "light") {
        root.setAttribute("data-theme", "light");
      } else if (t === "dark") {
        root.removeAttribute("data-theme");
      } else {
        root.removeAttribute("data-theme");
      }
    }
    themeListeners.forEach((cb) => cb());
  }, []);

  return (
    <header
      style={{
        gridArea: "topbar",
        height: "var(--topbar-height)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 40,
      }}
    >
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: "var(--accent)",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              color: "var(--text-strong)",
              lineHeight: 1.1,
            }}
          >
            TEI - Agent
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--muted)",
              fontWeight: 500,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Control
          </div>
        </div>
      </div>

      {/* Right side */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Connection status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 9999,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border)",
            background: "var(--secondary)",
            fontSize: 12,
            fontWeight: 500,
            color: "var(--muted)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--ok)",
              flexShrink: 0,
            }}
          />
          <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>localhost</span>
        </div>

        {/* Theme toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border)",
            borderRadius: 9999,
            background: "var(--secondary)",
            padding: 3,
            gap: 2,
          }}
        >
          {(["dark", "system", "light"] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => applyTheme(t)}
              title={t}
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                borderWidth: 0,
                background: theme === t ? "var(--accent)" : "transparent",
                color: theme === t ? "white" : "var(--muted)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                transition: "background 150ms ease, color 150ms ease",
              }}
            >
              {t === "dark" && <MoonIcon />}
              {t === "system" && <SystemIcon />}
              {t === "light" && <SunIcon />}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
