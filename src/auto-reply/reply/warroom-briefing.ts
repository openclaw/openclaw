/**
 * Warroom briefing builder — generates a condensed situational awareness
 * block for injection into the agent prompt as a context segment.
 *
 * Data source: Time Tunnel SQLite (via dynamic import of query.js).
 * Config source: workspace/data/warroom_dashboard_config.json.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";

const TIME_TUNNEL_QUERY_PATH = "/app/workspace/hooks/time-tunnel/query.js";

// Cache the briefing for 5 minutes to avoid re-querying on every message
let cachedBriefing: { text: string; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ChatMessage {
  id: number;
  timestamp: string;
  direction: string;
  channel: string;
  chat_id: string;
  chat_name: string;
  sender_id: string;
  sender_name: string;
  content: string;
  media_type: string;
}

interface WarroomConfig {
  version: string;
  monitored_chats: Array<{
    id: string;
    name: string;
    channel: string;
    agents: Array<{ id: string; name: string }>;
  }>;
  agent_visibility_threshold: number;
}

let timeTunnelModule: {
  getChatMessages: (
    chatId: string,
    opts?: { limit?: number; minutesBack?: number },
  ) => ChatMessage[];
} | null = null;

async function loadTimeTunnel() {
  if (timeTunnelModule) return timeTunnelModule;

  try {
    if (!existsSync(TIME_TUNNEL_QUERY_PATH)) return null;

    const mod = await import(TIME_TUNNEL_QUERY_PATH);
    if (typeof mod.getChatMessages !== "function") {
      return null;
    }

    timeTunnelModule = { getChatMessages: mod.getChatMessages };
    return timeTunnelModule;
  } catch {
    return null;
  }
}

function loadWarroomConfig(workspaceDir: string): WarroomConfig | null {
  try {
    const configPath = path.join(workspaceDir, "data/warroom_dashboard_config.json");
    if (!existsSync(configPath)) return null;

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const cfg = raw.warroom_dashboard;
    if (!cfg?.monitored_chats?.length) return null;

    return cfg;
  } catch {
    return null;
  }
}

function analyzeChatQuick(
  messages: ChatMessage[],
  agents: Array<{ id: string; name: string }>,
  threshold: number,
): {
  totalMessages: number;
  uniqueSenders: number;
  agentSummaries: Array<{ name: string; count: number; pct: number; overThreshold: boolean }>;
  latestTimestamp: string;
} {
  const senders = new Set<string>();
  let latest = "";

  for (const msg of messages) {
    senders.add(msg.sender_name || msg.sender_id || "?");
    if (msg.timestamp > latest) latest = msg.timestamp;
  }

  const agentSummaries = agents.map((agent) => {
    const count = messages.filter(
      (m) => m.direction === "outbound" || m.sender_id === agent.id,
    ).length;
    const pct = messages.length > 0 ? Math.round((count / messages.length) * 100) : 0;
    return { name: agent.name, count, pct, overThreshold: pct > threshold };
  });

  return {
    totalMessages: messages.length,
    uniqueSenders: senders.size,
    agentSummaries,
    latestTimestamp: latest,
  };
}

function formatBriefing(
  config: WarroomConfig,
  chatResults: Array<{
    name: string;
    channel: string;
    totalMessages: number;
    uniqueSenders: number;
    agentSummaries: Array<{ name: string; count: number; pct: number; overThreshold: boolean }>;
  }>,
): string {
  const lines: string[] = ["[Warroom Briefing — cross-field situational awareness]"];

  for (const r of chatResults) {
    const agentInfo = r.agentSummaries
      .map((a) => `${a.name} ${a.pct}%${a.overThreshold ? " OVER-EXPOSED" : ""}`)
      .join(", ");
    lines.push(
      `- ${r.name} (${r.channel}): ${r.totalMessages} msgs, ${r.uniqueSenders} people${agentInfo ? ` | ${agentInfo}` : ""}`,
    );
  }

  // Warnings
  const overExposed = chatResults.flatMap((r) =>
    r.agentSummaries.filter((a) => a.overThreshold).map((a) => `${a.name} in ${r.name}`),
  );
  if (overExposed.length > 0) {
    lines.push(`Warning: agent over-exposed in ${overExposed.join(", ")} — reduce visibility.`);
  }

  lines.push("[/Warroom Briefing]");
  return lines.join("\n");
}

/**
 * Build a warroom briefing string for injection as a context segment.
 * Returns empty string if disabled, no config, or no data.
 *
 * Results are cached for 5 minutes.
 */
export async function buildWarroomBriefing(workspaceDir: string): Promise<string> {
  // Check cache
  if (cachedBriefing && Date.now() < cachedBriefing.expiresAt) {
    return cachedBriefing.text;
  }

  try {
    const config = loadWarroomConfig(workspaceDir);
    if (!config) return "";

    const mod = await loadTimeTunnel();
    if (!mod) return "";

    const chatResults = [];

    for (const chat of config.monitored_chats) {
      const messages = mod.getChatMessages(chat.id, { limit: 50, minutesBack: 60 });
      if (!messages || messages.length === 0) continue;

      const analysis = analyzeChatQuick(
        messages,
        chat.agents || [],
        config.agent_visibility_threshold || 30,
      );

      chatResults.push({
        name: chat.name,
        channel: chat.channel,
        ...analysis,
      });
    }

    if (chatResults.length === 0) return "";

    const text = formatBriefing(config, chatResults);

    // Cache
    cachedBriefing = { text, expiresAt: Date.now() + CACHE_TTL_MS };

    return text;
  } catch {
    return "";
  }
}
