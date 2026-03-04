"use client";

import { useState, useCallback, useEffect } from "react";
import { formatRelativeTimestamp } from "@/lib/format";
import type {
  ChannelsStatusSnapshot,
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
} from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Types
// ============================================

type ChannelKey = string;

// ============================================
// Helpers
// ============================================

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) {
    return "Yes";
  }
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) {
    return "Yes";
  }
  if (account.connected === false) {
    return "No";
  }
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "n/a";
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

function channelEnabled(key: string, snapshot: ChannelsStatusSnapshot | null): boolean {
  const accounts = snapshot?.channelAccounts?.[key] ?? [];
  if (accounts.length > 0) {
    return accounts.some((a) => a.configured || a.running || a.connected);
  }
  const status = snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  return Boolean(status?.configured || status?.running || status?.connected);
}

// ============================================
// Styles
// ============================================

const styles = {
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
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
  muted: {
    color: "var(--muted)",
    fontSize: 13,
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
  statusList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    marginTop: 16,
  } as React.CSSProperties,
  statusRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 13,
  } as React.CSSProperties,
  statusLabel: {
    color: "var(--muted)",
  } as React.CSSProperties,
  statusValue: {
    color: "var(--text-strong)",
    fontWeight: 500,
  } as React.CSSProperties,
  accountCard: {
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    padding: 12,
    marginTop: 12,
  } as React.CSSProperties,
  accountHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  } as React.CSSProperties,
  accountTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-strong)",
  } as React.CSSProperties,
  accountId: {
    fontSize: 11,
    color: "var(--muted)",
    fontFamily: "var(--mono)",
  } as React.CSSProperties,
  pill: {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 9999,
    textTransform: "uppercase" as const,
  } as React.CSSProperties,
  pillOk: {
    background: "var(--ok-subtle)",
    color: "var(--ok)",
  } as React.CSSProperties,
  pillWarn: {
    background: "var(--warn-subtle)",
    color: "var(--warn)",
  } as React.CSSProperties,
  pillMuted: {
    background: "var(--bg-hover)",
    color: "var(--muted)",
  } as React.CSSProperties,
  codeBlock: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    padding: 12,
    overflow: "auto",
    maxHeight: 300,
    whiteSpace: "pre" as const,
    marginTop: 12,
  } as React.CSSProperties,
};

// ============================================
// AccountCard Component
// ============================================

function AccountCard({ account }: { account: ChannelAccountSnapshot }) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);
  const isActive = runningStatus === "Yes" || runningStatus === "Active";

  return (
    <div style={styles.accountCard}>
      <div style={styles.accountHeader}>
        <div>
          <div style={styles.accountTitle}>{account.name || account.accountId}</div>
          <div style={styles.accountId}>{account.accountId}</div>
        </div>
        <span
          style={{
            ...styles.pill,
            ...(isActive ? styles.pillOk : styles.pillMuted),
          }}
        >
          {isActive ? "Active" : "Inactive"}
        </span>
      </div>

      <div style={{ ...styles.statusList, marginTop: 8, gap: 4 }}>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Running</span>
          <span style={styles.statusValue}>{runningStatus}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Configured</span>
          <span style={styles.statusValue}>{account.configured ? "Yes" : "No"}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Connected</span>
          <span style={styles.statusValue}>{connectedStatus}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Last inbound</span>
          <span style={styles.statusValue}>
            {account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}
          </span>
        </div>
      </div>

      {account.lastError && (
        <div
          style={{
            ...styles.callout,
            ...styles.calloutDanger,
            marginTop: 8,
            padding: "6px 10px",
          }}
        >
          {account.lastError}
        </div>
      )}
    </div>
  );
}

// ============================================
// ChannelCard Component
// ============================================

function ChannelCard({
  channelKey,
  snapshot,
}: {
  channelKey: string;
  snapshot: ChannelsStatusSnapshot | null;
}) {
  const label = resolveChannelLabel(snapshot, channelKey);
  const accounts = snapshot?.channelAccounts?.[channelKey] ?? [];
  const status = (snapshot?.channels?.[channelKey] ?? {}) as Record<string, unknown>;
  const isEnabled = channelEnabled(channelKey, snapshot);

  const configured = typeof status.configured === "boolean" ? status.configured : undefined;
  const running = typeof status.running === "boolean" ? status.running : undefined;
  const connected = typeof status.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status.lastError === "string" ? status.lastError : undefined;

  return (
    <div style={{ ...styles.card, opacity: isEnabled ? 1 : 0.6 }}>
      <div style={styles.cardHeader}>
        <div>
          <div style={styles.cardTitle}>{label}</div>
          <div style={styles.cardSub}>
            {accounts.length > 0
              ? `${accounts.length} account${accounts.length > 1 ? "s" : ""}`
              : "Channel status"}
          </div>
        </div>
        <span
          style={{
            ...styles.pill,
            ...(isEnabled ? styles.pillOk : styles.pillMuted),
          }}
        >
          {isEnabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {accounts.length > 0 ? (
        accounts.map((account) => <AccountCard key={account.accountId} account={account} />)
      ) : (
        <div style={styles.statusList}>
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>Configured</span>
            <span style={styles.statusValue}>
              {configured == null ? "n/a" : configured ? "Yes" : "No"}
            </span>
          </div>
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>Running</span>
            <span style={styles.statusValue}>
              {running == null ? "n/a" : running ? "Yes" : "No"}
            </span>
          </div>
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>Connected</span>
            <span style={styles.statusValue}>
              {connected == null ? "n/a" : connected ? "Yes" : "No"}
            </span>
          </div>
        </div>
      )}

      {lastError && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{lastError}</div>}
    </div>
  );
}

// ============================================
// Main Channels Page
// ============================================

export default function ChannelsPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChannelsStatusSnapshot | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const loadChannels = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await request<ChannelsStatusSnapshot>("channels.status", {});
      setSnapshot(res);
      setLastSuccessAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load channels");
    } finally {
      setLoading(false);
    }
  }, [state, request]);

  useEffect(() => {
    if (state === "connected") {
      void loadChannels();
    }
  }, [state, loadChannels]);

  const channelOrder = resolveChannelOrder(snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, snapshot),
      order: index,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.order - b.order;
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
          Channels
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Manage connected chat channels: Telegram, Discord, Slack, and more.
        </p>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <button style={styles.btn} disabled={isDisabled} onClick={loadChannels}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <button style={styles.btn} onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Hide Raw" : "Show Raw"}
        </button>
      </div>

      {error && (
        <div
          style={{
            ...styles.callout,
            ...styles.calloutDanger,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div style={styles.grid}>
        {orderedChannels.map(({ key }) => (
          <ChannelCard key={key} channelKey={key} snapshot={snapshot} />
        ))}
      </div>

      {showRaw && (
        <div style={{ ...styles.card, marginTop: 24 }}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Channel Health</div>
              <div style={styles.cardSub}>Raw channel status from gateway.</div>
            </div>
            <div style={styles.muted}>
              {lastSuccessAt ? formatRelativeTimestamp(lastSuccessAt) : "n/a"}
            </div>
          </div>
          <pre style={styles.codeBlock}>
            {snapshot ? JSON.stringify(snapshot, null, 2) : "No snapshot yet."}
          </pre>
        </div>
      )}
    </div>
  );
}
