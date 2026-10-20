import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type {
  ChannelAccountHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
} from "../gateway/health/types.js";
import type { ChannelRuntimeSnapshot } from "../gateway/server-channel-runtime.types.js";

export function channelRuntime(
  id: string,
  state: ChannelAccountSnapshot,
  byAccount = false,
): ChannelRuntimeSnapshot {
  return byAccount
    ? { channels: {}, channelAccounts: { [id]: { [state.accountId]: state } } }
    : { channels: { [id]: state }, channelAccounts: {} };
}

const emptyHealthSessions: HealthSummary["sessions"] = {
  path: "/tmp/sessions.json",
  count: 0,
  recent: [],
};
const healthAgent = (sessions = emptyHealthSessions) => ({
  agentId: "main",
  isDefault: true,
  heartbeat: {
    enabled: true,
    every: "1m",
    everyMs: 60_000,
    prompt: "hi",
    target: "last",
    ackMaxChars: 160,
  },
  sessions,
});

export function healthSummary(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 5,
    heartbeatSeconds: 60,
    defaultAgentId: "main",
    agents: [healthAgent(overrides.sessions)],
    sessions: emptyHealthSessions,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    ...overrides,
  };
}

export function multiAccountHealth(
  secondary: Partial<ChannelAccountHealthSummary>,
  primaryOverrides: Partial<ChannelAccountHealthSummary> = {},
): HealthSummary {
  const active = { enabled: true, configured: true, linked: true };
  const primary = {
    ...active,
    accountId: "main",
    healthState: "healthy",
    probe: { ok: true, elapsedMs: 12 },
    ...primaryOverrides,
  };
  const sibling = { ...active, accountId: "alerts", ...secondary };
  return healthSummary({
    channels: {
      matrix: {
        ...primary,
        accounts: { [primary.accountId]: primary, [sibling.accountId]: sibling },
      },
    },
    channelOrder: ["matrix"],
    channelLabels: { matrix: "Matrix" },
  });
}

export function pluginHealthError(
  id: string,
  error: string,
  overrides: Partial<PluginHealthErrorSummary> = {},
): PluginHealthErrorSummary {
  return { id, error, origin: "workspace", activated: false, ...overrides };
}

export function unavailablePlugin(
  id: string,
  detail = "manifest unreadable",
): NonNullable<PluginHealthSummary["unavailable"]>[number] {
  return {
    id,
    state: "configured-unavailable",
    diagnostic: { kind: "plugin-verification", reason: "unreadable-package-json", detail },
  };
}
