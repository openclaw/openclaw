import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
export const DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION = 1;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

/** Hard ceiling matching the zod schema `.max(10)` — enforced at runtime too. */
export const MAX_CONCURRENT_PER_CONVERSATION = 10;

export function resolveAgentMaxConcurrentPerConversation(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrentPerConversation;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(MAX_CONCURRENT_PER_CONVERSATION, Math.max(1, Math.floor(raw)));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

// ---------------------------------------------------------------------------
// Per-channel conversation concurrency override
// ---------------------------------------------------------------------------

/** Strip delivery-target prefixes (channel:, group:, user:, thread:) to get bare config lookup ID. */
function stripPeerPrefix(peerId: string | undefined): string | undefined {
  if (!peerId) {
    return undefined;
  }
  const idx = peerId.indexOf(":");
  return idx >= 0 ? peerId.slice(idx + 1) : peerId;
}

/** Return value as a positive integer, or undefined if invalid/missing. */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.min(MAX_CONCURRENT_PER_CONVERSATION, Math.floor(value));
}

/**
 * Resolve `maxConcurrentPerConversation` using the established channel config cascade:
 *
 *   Discord:  channel → guild → provider → global
 *   Telegram: group → provider → global
 *   Slack:    channel → provider → global
 *   Others:   provider → global
 */
export function resolveMaxConcurrentPerConversation(params: {
  cfg?: OpenClawConfig;
  channel?: string;
  groupSpace?: string | null;
  peerId?: string;
}): number {
  const globalDefault = resolveAgentMaxConcurrentPerConversation(params.cfg);
  const channelKey = params.channel?.toLowerCase();
  if (!channelKey) {
    return globalDefault;
  }

  if (channelKey === "discord") {
    const config = params.cfg?.channels?.discord;
    const guild = params.groupSpace ? config?.guilds?.[params.groupSpace] : undefined;
    const channelId = stripPeerPrefix(params.peerId);
    const channel = channelId ? guild?.channels?.[channelId] : undefined;
    return (
      asPositiveInt(channel?.maxConcurrentPerConversation) ??
      asPositiveInt(guild?.maxConcurrentPerConversation) ??
      asPositiveInt(config?.maxConcurrentPerConversation) ??
      globalDefault
    );
  }

  if (channelKey === "telegram") {
    const config = params.cfg?.channels?.telegram;
    // groupSpace is NOT populated for Telegram; extract group ID from peerId
    const groupId = stripPeerPrefix(params.groupSpace ?? params.peerId);
    const group = groupId ? config?.groups?.[groupId] : undefined;
    return (
      asPositiveInt(group?.maxConcurrentPerConversation) ??
      asPositiveInt(config?.maxConcurrentPerConversation) ??
      globalDefault
    );
  }

  if (channelKey === "slack") {
    const config = params.cfg?.channels?.slack;
    const channelId = stripPeerPrefix(params.peerId);
    const channel = channelId ? config?.channels?.[channelId] : undefined;
    return (
      asPositiveInt(channel?.maxConcurrentPerConversation) ??
      asPositiveInt(config?.maxConcurrentPerConversation) ??
      globalDefault
    );
  }

  // Flat providers: provider-level only via dynamic key.
  // Safety: the `as` cast is needed because ChannelsConfig uses `[key: string]: any`
  // for extension providers. `asPositiveInt` performs full runtime validation so an
  // incorrect field type falls through to `globalDefault` rather than producing a bad value.
  const providerConfig = params.cfg?.channels?.[channelKey] as
    | { maxConcurrentPerConversation?: number }
    | undefined;
  return asPositiveInt(providerConfig?.maxConcurrentPerConversation) ?? globalDefault;
}
