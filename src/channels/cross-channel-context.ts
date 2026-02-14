/**
 * Level 105: Cross-channel context awareness
 *
 * Queries Time Tunnel for recent messages from OTHER channels handled by
 * the same agent, so the agent can see what was discussed elsewhere.
 */

import { existsSync } from "fs";
import { resolve } from "path";

const TIME_TUNNEL_QUERY_PATH = resolve(
  process.env.OPENCLAW_WORKSPACE || "/app/workspace",
  "hooks/time-tunnel/query.js",
);

let timeTunnelModule: {
  getCrossChannelContext: (params: {
    agentId: string;
    currentChannel: string;
    minutesBack?: number;
    limit?: number;
  }) => Array<{
    timestamp: string;
    channel: string;
    direction: string;
    sender: string;
    content: string;
  }>;
} | null = null;

async function loadModule() {
  if (timeTunnelModule) {
    return timeTunnelModule;
  }

  try {
    if (!existsSync(TIME_TUNNEL_QUERY_PATH)) {
      return null;
    }

    const mod = await import(TIME_TUNNEL_QUERY_PATH);
    if (typeof mod.getCrossChannelContext !== "function") {
      console.log("[cross-channel] getCrossChannelContext not found in Time Tunnel module");
      return null;
    }

    timeTunnelModule = { getCrossChannelContext: mod.getCrossChannelContext };
    console.log("[cross-channel] Time Tunnel module loaded");
    return timeTunnelModule;
  } catch (err) {
    console.error("[cross-channel] Failed to load Time Tunnel module:", err);
    return null;
  }
}

export function formatElapsed(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m ago`;
}

/**
 * Build a text block of recent messages from other channels for the same agent.
 * Returns null if no cross-channel messages found or module unavailable.
 */
export async function buildCrossChannelContext(params: {
  currentChannel: string;
  agentId?: string;
  minutesBack?: number;
  messageLimit?: number;
}): Promise<string | null> {
  const { currentChannel, agentId, minutesBack = 30, messageLimit = 10 } = params;

  if (!agentId) {
    return null;
  }

  try {
    const mod = await loadModule();
    if (!mod) {
      return null;
    }

    const messages = mod.getCrossChannelContext({
      agentId,
      currentChannel,
      minutesBack,
      limit: messageLimit,
    });

    if (!messages || messages.length === 0) {
      return null;
    }

    const lines = messages.map((msg) => {
      const elapsed = formatElapsed(msg.timestamp);
      const channel = msg.channel?.toUpperCase() || "OTHER";
      const sender = msg.direction === "outbound" ? "You replied" : msg.sender || "unknown";
      const content = (msg.content || "").substring(0, 300);
      return `[${channel} ${elapsed}] ${sender}: ${content}`;
    });

    console.log(`[cross-channel] Injecting ${messages.length} messages from other channels`);

    return [
      "[Recent activity on other channels]",
      ...lines,
      "[/Recent activity on other channels]",
    ].join("\n");
  } catch (err) {
    console.error("[cross-channel] Error building context:", err);
    return null;
  }
}
