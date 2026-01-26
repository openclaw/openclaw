/**
 * Discord Bot Presence Manager
 *
 * Manages the bot's presence/status display, including activity type and status text.
 * Can optionally show token usage information after each message.
 */

import type { GatewayPlugin } from "@buape/carbon/gateway";
import type { UpdatePresenceData, Activity } from "@buape/carbon/gateway";
import { logVerbose } from "../../globals.js";

export type PresenceConfig = {
  enabled?: boolean;
  showTokenUsage?: boolean;
  format?: string;
  // Note: Bots cannot use "Custom" activity type - Discord API limitation
  activityType?: "Playing" | "Watching" | "Listening" | "Competing";
  status?: "online" | "idle" | "dnd" | "invisible";
};

export type PresenceContext = {
  sessionKey?: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  provider?: string;
};

// Activity type mapping
// Note: Bots CANNOT use type 4 (Custom) - that's user-only
// Available for bots: Playing (0), Streaming (1), Listening (2), Watching (3), Competing (5)
const ACTIVITY_TYPE_MAP: Record<string, number> = {
  Playing: 0, // "Playing {name}"
  Streaming: 1, // "Streaming {name}"
  Listening: 2, // "Listening to {name}"
  Watching: 3, // "Watching {name}"
  Competing: 5, // "Competing in {name}"
};

// Track cumulative tokens per session
const sessionTokens = new Map<string, number>();

/**
 * Create a presence manager for a Discord gateway
 */
export function createPresenceManager(params: {
  gateway: GatewayPlugin;
  config: PresenceConfig;
  accountId: string;
}) {
  const { gateway, config, accountId } = params;

  const defaultFormat = config.showTokenUsage ? "📊 {tokens} tokens" : "";
  const format = config.format ?? defaultFormat;
  // Default to "Watching" as it reads well: "Watching 📊 1,234 tokens"
  const activityType = config.activityType ?? "Watching";
  const status = config.status ?? "online";

  /**
   * Format the presence text with context variables
   */
  function formatPresenceText(ctx: PresenceContext): string {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const currentTokens = sessionTokens.get(sessionKey) ?? 0;
    const newTokens = ctx.tokens ?? 0;
    const totalTokens = currentTokens + newTokens;

    if (newTokens > 0) {
      sessionTokens.set(sessionKey, totalTokens);
    }

    return format
      .replace("{tokens}", totalTokens.toLocaleString())
      .replace("{input}", (ctx.inputTokens ?? 0).toLocaleString())
      .replace("{output}", (ctx.outputTokens ?? 0).toLocaleString())
      .replace("{model}", ctx.model ?? "unknown")
      .replace("{provider}", ctx.provider ?? "unknown")
      .replace("{session}", sessionKey);
  }

  /**
   * Update the bot's presence
   */
  function updatePresence(ctx?: PresenceContext): void {
    if (!config.enabled) {
      return;
    }

    if (!gateway.isConnected) {
      logVerbose(`[discord:${accountId}] Cannot update presence: gateway not connected`);
      return;
    }

    try {
      const text = ctx ? formatPresenceText(ctx) : "";
      const activities: Activity[] = text
        ? [
            {
              name: text,
              type: ACTIVITY_TYPE_MAP[activityType] ?? 3, // Default to Watching (3)
            },
          ]
        : [];

      const presenceData: UpdatePresenceData = {
        since: null,
        activities,
        status: status as "online" | "dnd" | "idle" | "invisible" | "offline",
        afk: false,
      };

      gateway.updatePresence(presenceData);
      logVerbose(`[discord:${accountId}] Updated presence: ${text || "(cleared)"}`);
    } catch (err) {
      logVerbose(`[discord:${accountId}] Failed to update presence: ${String(err)}`);
    }
  }

  /**
   * Clear the bot's presence (remove activity)
   */
  function clearPresence(): void {
    if (!gateway.isConnected) {
      return;
    }

    try {
      gateway.updatePresence({
        since: null,
        activities: [],
        status: status as "online" | "dnd" | "idle" | "invisible" | "offline",
        afk: false,
      });
      logVerbose(`[discord:${accountId}] Cleared presence`);
    } catch (err) {
      logVerbose(`[discord:${accountId}] Failed to clear presence: ${String(err)}`);
    }
  }

  /**
   * Reset token tracking for a session
   */
  function resetSessionTokens(sessionKey: string): void {
    sessionTokens.delete(sessionKey);
  }

  return {
    updatePresence,
    clearPresence,
    resetSessionTokens,
    getSessionTokens: (sessionKey: string) => sessionTokens.get(sessionKey) ?? 0,
  };
}

export type PresenceManager = ReturnType<typeof createPresenceManager>;
