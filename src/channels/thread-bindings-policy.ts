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

/** Session family that can request automatic thread binding on spawn. */
export type ThreadBindingSpawnKind = "subagent" | "acp";

export type ThreadBindingSpawnPolicy = {
  /** Normalized channel id whose config supplied the policy. */
  channel: string;
  /** Normalized account id whose config supplied the policy. */
  accountId: string;
  /** True when thread bindings are enabled for the channel/account/session. */
  enabled: boolean;
  /** True when this spawn kind may create thread-bound sessions. */
  spawnEnabled: boolean;
  /** Default session relationship for spawned thread-bound sessions. */
  defaultSpawnContext: ThreadBindingSpawnContext;
};

/** Spawn relationship used when a channel opens a new bound thread. */
export type ThreadBindingSpawnContext = "isolated" | "fork";

function normalizeChannelId(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

export function supportsAutomaticThreadBindingSpawn(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

export function requiresNativeThreadContextForThreadHere(channel: string): boolean {
  return resolveDefaultTopLevelPlacement(channel) === "child";
}

/**
 * Chooses whether a command should bind to the current native thread or create
 * a child thread for the first bound session in channels that require threads.
 */
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
  // Date arithmetic downstream stores absolute timestamps, so clamp durations
  // to the maximum representable timestamp instead of letting overflow wrap.
  return Math.min(durationMs, MAX_DATE_TIMESTAMP_MS);
}

/**
 * Resolves idle timeout duration with channel/account config taking precedence
 * over the global session default.
 */
export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  return resolveThreadBindingHoursMs(
    params.channelIdleHoursRaw,
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ?? DEFAULT_THREAD_BINDING_IDLE_HOURS,
  );
}

/** Resolves max-age duration using the same channel-over-session precedence. */
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

/** Returns the lifecycle expiration timestamp for an existing binding record. */
export function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  return resolveSharedThreadBindingLifecycle(params).expiresAt;
}

/** Resolves whether thread bindings are enabled after channel/account override. */
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

/**
 * Resolves spawn policy for a specific channel/account/session family.
 *
 * Kind-specific spawn flags win over generic spawnSessions, and account config
 * wins over channel root config so multi-account channels can opt out safely.
 */
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

/** Resolves idle timeout for a concrete channel/account configuration scope. */
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

/** Resolves max age for a concrete channel/account configuration scope. */
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

export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread bindings are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).`;
}

export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  return `Thread-bound session spawns are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.spawnSessions=true to enable).`;
}
