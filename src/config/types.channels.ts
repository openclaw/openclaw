import type { ContextVisibilityMode, GroupPolicy } from "./types.base.js";

export type ChannelHeartbeatVisibilityConfig = {
  /** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
  showOk?: boolean;
  /** Show heartbeat alerts with actual content (default: true). */
  showAlerts?: boolean;
  /** Emit indicator events for UI status display (default: true). */
  useIndicator?: boolean;
};

export type ChannelHealthMonitorConfig = {
  /**
   * Enable channel-health-monitor restarts for this channel or account.
   * Inherits the global gateway setting when omitted.
   */
  enabled?: boolean;
};

export type ChannelDefaultsConfig = {
  groupPolicy?: GroupPolicy;
  contextVisibility?: ContextVisibilityMode;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

/**
 * Operator-visibility channel target for boot/resume/cron operator-only signals.
 *
 * When configured, boot/resume-class messages and `notifyPolicy: "operator_only"`
 * cron emissions are rerouted here instead of being suppressed. When unset,
 * those messages are suppressed entirely (never surfaced on user channels).
 *
 * Shape matches `ResolvedSurfaceTarget` at
 * `src/infra/outbound/surface-policy.ts` so callers can feed this value
 * directly into `planDelivery`.
 */
export type ChannelOperatorTarget = {
  /** Channel plugin id (e.g. "discord", "telegram"). */
  channel: string;
  /** Target address resolved for that channel (e.g. channel id, chat id). */
  to: string;
  /** Optional account id for multi-account setups. */
  accountId?: string;
  /** Optional thread/topic id for channels that support threading. */
  threadId?: string | number;
};

export type ExtensionNestedPolicyConfig = {
  policy?: string;
  allowFrom?: Array<string | number> | ReadonlyArray<string | number>;
  [key: string]: unknown;
};

/**
 * Base type for extension channel config sections.
 * Extensions can use this as a starting point for their channel config.
 */
export type ExtensionChannelConfig = {
  enabled?: boolean;
  allowFrom?: Array<string | number> | ReadonlyArray<string | number>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string | number;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  dmPolicy?: string;
  groupPolicy?: GroupPolicy;
  contextVisibility?: ContextVisibilityMode;
  healthMonitor?: ChannelHealthMonitorConfig;
  dm?: ExtensionNestedPolicyConfig;
  network?: Record<string, unknown>;
  groups?: Record<string, unknown>;
  rooms?: Record<string, unknown>;
  mediaMaxMb?: number;
  callbackBaseUrl?: string;
  interactions?: { callbackBaseUrl?: string; [key: string]: unknown };
  execApprovals?: Record<string, unknown>;
  threadBindings?: {
    enabled?: boolean;
    spawnAcpSessions?: boolean;
    spawnSubagentSessions?: boolean;
  };
  spawnSubagentSessions?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  accounts?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ChannelsConfig {
  defaults?: ChannelDefaultsConfig;
  /** Map provider -> channel id -> model override. */
  modelByChannel?: ChannelModelByChannelConfig;
  /**
   * Operator-visibility channel target for boot/resume/cron operator-only signals.
   *
   * When configured, boot/resume-class messages and cron jobs with
   * `notifyPolicy: "operator_only"` are rerouted here instead of posting to
   * user-facing surfaces. When unset, those signals are suppressed entirely.
   */
  operator?: ChannelOperatorTarget;
  /**
   * Channel sections are plugin-owned and keyed by arbitrary channel ids.
   * Keep the lookup permissive so augmented channel configs remain ergonomic at call sites.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
