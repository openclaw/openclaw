import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  resolveThreadBindingLifecycle as resolveSharedThreadBindingLifecycle,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";
import { getLoadedChannelPlugin } from "./plugins/index.js";
import { resolveBundledChannelThreadBindingDefaultPlacement } from "./plugins/thread-binding-api.js";

export {
  resolveThreadBindingLifecycle,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";

const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

type SessionThreadBindingsConfigShape = {
  enabled?: unknown;
  idleHours?: unknown;
  maxAgeHours?: unknown;
  spawnSessions?: unknown;
  spawnSubagentSessions?: unknown;
  spawnAcpSessions?: unknown;
  defaultSpawnContext?: unknown;
};

type ChannelThreadBindingsContainerShape = {
  threadBindings?: SessionThreadBindingsConfigShape;
  accounts?: Record<string, { threadBindings?: SessionThreadBindingsConfigShape } | undefined>;
};

export type ThreadBindingSpawnKind = "subagent" | "acp";

/** Resolved spawn policy for a channel/account/kind combination. */
export type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
  defaultSpawnContext: ThreadBindingSpawnContext;
};

export type ThreadBindingSpawnContext = "isolated" | "fork";

function normalizeChannelId(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

/** Returns true when a channel's top-level thread binding should spawn a child session. */
export function supportsAutomaticThreadBindingSpawn(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

/** Returns true when `/thread here` needs native thread context instead of current session reuse. */
export function requiresNativeThreadContextForThreadHere(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

/** Resolves whether a thread binding should use the current session or spawn a child. */
export function resolveThreadBindingPlacementForCurrentContext(params: {
  channel: string;
  threadId?: string;
}): "current" | "child" {
  if (resolveDefaultTopLevelPlacement(params.channel) !== "child") {
    return "current";
  }
  return params.threadId ? "current" : "child";
}

function resolveDefaultTopLevelPlacement(channel: string): "current" | "child" {
  const normalized = normalizeChannelId(channel);
  if (!normalized) {
    return "current";
  }
  return (
    // Loaded plugins win over bundled defaults so external channels can define
    // their native top-level thread behavior without core channel ids.
    getLoadedChannelPlugin(normalized)?.conversationBindings?.defaultTopLevelPlacement ??
    resolveBundledChannelThreadBindingDefaultPlacement(normalized) ??
    "current"
  );
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

function resolveThreadBindingHoursMs(raw: unknown, fallbackHours: number): number {
  const hours = normalizeThreadBindingHours(raw) ?? fallbackHours;
  const durationMs = Math.floor(hours * 60 * 60 * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }
  return Math.min(durationMs, MAX_DATE_TIMESTAMP_MS);
}

/** Resolves idle expiry in milliseconds, with channel/account config overriding session defaults. */
export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  return resolveThreadBindingHoursMs(
    params.channelIdleHoursRaw,
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ?? DEFAULT_THREAD_BINDING_IDLE_HOURS,
  );
}

/** Resolves absolute max-age expiry in milliseconds, with zero meaning no max-age limit. */
export function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  return resolveThreadBindingHoursMs(
    params.channelMaxAgeHoursRaw,
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
      DEFAULT_THREAD_BINDING_MAX_AGE_HOURS,
  );
}

/** Returns the effective expiry timestamp for a binding lifecycle record. */
export function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  return resolveSharedThreadBindingLifecycle(params).expiresAt;
}

/** Resolves whether thread bindings are enabled, defaulting open when unset. */
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

function normalizeSpawnContext(value: unknown): ThreadBindingSpawnContext | undefined {
  return value === "isolated" || value === "fork" ? value : undefined;
}

/** Resolves account/channel/global spawn policy for subagent or ACP thread bindings. */
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
    // Kind-specific flags override the broad spawnSessions flag at each scope.
    normalizeBoolean(account?.[spawnFlagKey]) ??
    normalizeBoolean(account?.spawnSessions) ??
    normalizeBoolean(root?.[spawnFlagKey]) ??
    normalizeBoolean(root?.spawnSessions) ??
    normalizeBoolean(params.cfg.session?.threadBindings?.spawnSessions);
  const spawnEnabled = spawnEnabledRaw ?? true;
  const defaultSpawnContext =
    normalizeSpawnContext(account?.defaultSpawnContext) ??
    normalizeSpawnContext(root?.defaultSpawnContext) ??
    normalizeSpawnContext(params.cfg.session?.threadBindings?.defaultSpawnContext) ??
    "fork";
  return {
    channel,
    accountId,
    enabled,
    spawnEnabled,
    defaultSpawnContext,
  };
}

/** Resolves idle timeout using channel/account scoped thread-binding config. */
export function resolveThreadBindingIdleTimeoutMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const { root, account } = resolveThreadBindingChannelScope(params);
  return resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
    sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours,
  });
}

/** Resolves max age using channel/account scoped thread-binding config. */
export function resolveThreadBindingMaxAgeMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number {
  const { root, account } = resolveThreadBindingChannelScope(params);
  return resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
    sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours,
  });
}

function resolveThreadBindingChannelScope(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}) {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  return resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
}

/** Formats a user-facing error for disabled thread bindings. */
export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread bindings are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).`;
}

/** Formats a user-facing error for disabled thread-bound session spawning. */
export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread-bound session spawns are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.spawnSessions=true to enable).`;
}
