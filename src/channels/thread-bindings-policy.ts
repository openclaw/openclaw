import type { OpenClawConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";

export const DISCORD_THREAD_BINDING_CHANNEL = "discord";
const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

type SessionThreadBindingsConfigShape = {
  enabled?: unknown;
  idleHours?: unknown;
  maxAgeHours?: unknown;
  spawnSubagentSessions?: unknown;
  spawnAcpSessions?: unknown;
};

type ChannelThreadBindingsContainerShape = {
  threadBindings?: SessionThreadBindingsConfigShape;
  accounts?: Record<string, { threadBindings?: SessionThreadBindingsConfigShape } | undefined>;
};

export type ThreadBindingSpawnKind = "subagent" | "acp";

export type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
};

function normalizeChannelId(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

function normalizeThreadBindingHours(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (raw < 0) {
    return undefined;
  }
  return raw;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  const idleHours =
    normalizeThreadBindingHours(params.channelIdleHoursRaw) ??
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ??
    DEFAULT_THREAD_BINDING_IDLE_HOURS;
  return Math.floor(idleHours * 60 * 60 * 1000);
}

export function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  const maxAgeHours =
    normalizeThreadBindingHours(params.channelMaxAgeHoursRaw) ??
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
    DEFAULT_THREAD_BINDING_MAX_AGE_HOURS;
  return Math.floor(maxAgeHours * 60 * 60 * 1000);
}

export function resolveThreadBindingsEnabled(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeBoolean(params.channelEnabledRaw) ?? normalizeBoolean(params.sessionEnabledRaw) ?? true
  );
}

function resolveChannelThreadBindings(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
}): {
  root?: SessionThreadBindingsConfigShape;
  account?: SessionThreadBindingsConfigShape;
} {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channel] as
    | ChannelThreadBindingsContainerShape
    | undefined;
  const accountConfig = channelConfig?.accounts?.[params.accountId];
  return {
    root: channelConfig?.threadBindings,
    account: accountConfig?.threadBindings,
  };
}

function resolveSpawnFlagKey(
  kind: ThreadBindingSpawnKind,
): "spawnSubagentSessions" | "spawnAcpSessions" {
  return kind === "subagent" ? "spawnSubagentSessions" : "spawnAcpSessions";
}

export function resolveThreadBindingSpawnPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  kind: ThreadBindingSpawnKind;
}): ThreadBindingSpawnPolicy {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  const enabled =
    normalizeBoolean(account?.enabled) ??
    normalizeBoolean(root?.enabled) ??
    normalizeBoolean(params.cfg.session?.threadBindings?.enabled) ??
    true;
  const spawnFlagKey = resolveSpawnFlagKey(params.kind);
  const spawnEnabledRaw =
    normalizeBoolean(account?.[spawnFlagKey]) ?? normalizeBoolean(root?.[spawnFlagKey]);
  // Non-Discord channels currently have no dedicated spawn gate config keys.
  const spawnEnabled = spawnEnabledRaw ?? channel !== DISCORD_THREAD_BINDING_CHANNEL;
  return {
    channel,
    accountId,
    enabled,
    spawnEnabled,
  };
}

export function resolveThreadBindingIdleTimeoutMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  return resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
    sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours,
  });
}

export function resolveThreadBindingMaxAgeMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  return resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
    sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours,
  });
}

export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL) {
    return "Discord thread bindings are disabled (set channels.discord.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).";
  }
  return `Thread bindings are disabled for ${params.channel} (set session.threadBindings.enabled=true to enable).`;
}

export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL && params.kind === "acp") {
    return "Discord thread-bound ACP spawns are disabled for this account (set channels.discord.threadBindings.spawnAcpSessions=true to enable).";
  }
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL && params.kind === "subagent") {
    return "Discord thread-bound subagent spawns are disabled for this account (set channels.discord.threadBindings.spawnSubagentSessions=true to enable).";
  }
  return `Thread-bound ${params.kind} spawns are disabled for ${params.channel}.`;
}
