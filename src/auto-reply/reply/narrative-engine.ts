/**
 * Narrative variant engine — selects the right framing and talking points
 * for the current language field, injected as a context segment.
 *
 * "操控不是強推，是讓每個語場自己『長出』你想要的結果。"
 *
 * Data source: workspace/data/narrative-variants.json
 * Tracking: Time Tunnel SQLite (keyword adoption by others)
 */

import { existsSync, readFileSync } from "fs";
import path from "path";

const TIME_TUNNEL_QUERY_PATH = "/app/workspace/hooks/time-tunnel/query.js";

interface NarrativeVariant {
  field_pattern: string;
  framing: string;
  tone: string;
  talking_points: string[];
  forbidden_words: string[];
}

interface Agenda {
  id: string;
  topic: string;
  description: string;
  variants: NarrativeVariant[];
}

interface NarrativeConfig {
  version: string;
  agendas: Agenda[];
  tracking: {
    enabled: boolean;
    track_keywords_in_others_messages: boolean;
    conversion_window_minutes: number;
  };
}

// Cache config (reload every 10 minutes)
let cachedConfig: { config: NarrativeConfig; expiresAt: number } | null = null;
const CONFIG_CACHE_TTL = 10 * 60 * 1000;

// Cache conversion scores (per agenda, per chat)
let cachedConversions: {
  scores: Map<string, number>;
  expiresAt: number;
} | null = null;
const CONVERSION_CACHE_TTL = 15 * 60 * 1000;

let timeTunnelModule: {
  getChatMessages: (
    chatId: string,
    opts?: { limit?: number; minutesBack?: number },
  ) => Array<{
    direction: string;
    sender_name: string;
    content: string;
    timestamp: string;
  }>;
} | null = null;

async function loadTimeTunnel() {
  if (timeTunnelModule) return timeTunnelModule;
  try {
    if (!existsSync(TIME_TUNNEL_QUERY_PATH)) return null;
    const mod = await import(TIME_TUNNEL_QUERY_PATH);
    if (typeof mod.getChatMessages !== "function") return null;
    timeTunnelModule = { getChatMessages: mod.getChatMessages };
    return timeTunnelModule;
  } catch {
    return null;
  }
}

function loadNarrativeConfig(workspaceDir: string): NarrativeConfig | null {
  if (cachedConfig && Date.now() < cachedConfig.expiresAt) {
    return cachedConfig.config;
  }

  try {
    const configPath = path.join(workspaceDir, "data/narrative-variants.json");
    if (!existsSync(configPath)) return null;

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as NarrativeConfig;
    if (!config.agendas?.length) return null;

    cachedConfig = { config, expiresAt: Date.now() + CONFIG_CACHE_TTL };
    return config;
  } catch {
    return null;
  }
}

/**
 * Match a variant to the current chat by field_pattern (regex against sessionKey/chatName).
 */
function matchVariant(
  agenda: Agenda,
  sessionKey: string,
  chatName?: string,
): NarrativeVariant | null {
  const matchTarget = `${sessionKey} ${chatName || ""}`.toLowerCase();

  for (const variant of agenda.variants) {
    try {
      const pattern = new RegExp(variant.field_pattern, "i");
      if (pattern.test(matchTarget)) {
        return variant;
      }
    } catch {
      // Invalid regex, try simple includes
      if (matchTarget.includes(variant.field_pattern.toLowerCase())) {
        return variant;
      }
    }
  }

  return null;
}

/**
 * Track whether talking points have been adopted by others in the chat.
 * Returns a conversion score (0-100%) per agenda.
 */
async function trackConversion(
  chatId: string,
  agendas: Array<{ id: string; talkingPoints: string[] }>,
  windowMinutes: number,
): Promise<Map<string, number>> {
  // Use cache if fresh
  if (cachedConversions && Date.now() < cachedConversions.expiresAt) {
    return cachedConversions.scores;
  }

  const scores = new Map<string, number>();

  try {
    const mod = await loadTimeTunnel();
    if (!mod) return scores;

    const messages = mod.getChatMessages(chatId, { limit: 200, minutesBack: windowMinutes });
    // Only look at OTHER people's messages (inbound, not from agent)
    const othersMessages = messages.filter((m) => m.direction === "inbound");
    const othersText = othersMessages.map((m) => (m.content || "").toLowerCase()).join(" ");

    for (const agenda of agendas) {
      if (agenda.talkingPoints.length === 0) {
        scores.set(agenda.id, 0);
        continue;
      }

      // Check how many talking point keywords appear in others' messages
      let hits = 0;
      for (const tp of agenda.talkingPoints) {
        // Extract key phrases (3+ char segments) from talking points
        const keywords = tp.toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z]{4,}/g);
        if (keywords?.some((kw) => othersText.includes(kw))) {
          hits++;
        }
      }

      const score = Math.round((hits / agenda.talkingPoints.length) * 100);
      scores.set(agenda.id, score);
    }
  } catch {
    // Silently fail
  }

  cachedConversions = { scores, expiresAt: Date.now() + CONVERSION_CACHE_TTL };
  return scores;
}

/**
 * Build a narrative guide string for injection as a context segment.
 * Returns empty string if no matching variants for current chat.
 */
export async function buildNarrativeGuide(
  workspaceDir: string,
  sessionKey: string,
  chatName?: string,
): Promise<string> {
  try {
    const config = loadNarrativeConfig(workspaceDir);
    if (!config) return "";

    const matchedAgendas: Array<{
      agenda: Agenda;
      variant: NarrativeVariant;
    }> = [];

    for (const agenda of config.agendas) {
      const variant = matchVariant(agenda, sessionKey, chatName);
      if (variant) {
        matchedAgendas.push({ agenda, variant });
      }
    }

    if (matchedAgendas.length === 0) return "";

    // Track conversions if enabled
    let conversions = new Map<string, number>();
    if (config.tracking?.enabled) {
      conversions = await trackConversion(
        sessionKey,
        matchedAgendas.map((m) => ({
          id: m.agenda.id,
          talkingPoints: m.variant.talking_points,
        })),
        config.tracking.conversion_window_minutes || 120,
      );
    }

    // Format the guide
    const lines: string[] = ["[Narrative Guide — use these framings naturally, never force them]"];

    for (const { agenda, variant } of matchedAgendas) {
      const convScore = conversions.get(agenda.id);
      const convLabel = convScore != null ? ` (adoption: ${convScore}%)` : "";

      lines.push(`Topic: ${agenda.topic} | Framing: ${variant.framing}${convLabel}`);
      lines.push(`Tone: ${variant.tone}`);

      if (variant.talking_points.length > 0) {
        lines.push("Talking points (weave in naturally when relevant):");
        for (const tp of variant.talking_points) {
          lines.push(`  - ${tp}`);
        }
      }

      if (variant.forbidden_words.length > 0) {
        lines.push(`NEVER use: ${variant.forbidden_words.join(", ")}`);
      }

      lines.push(""); // blank line between agendas
    }

    lines.push(
      "Remember: do NOT push these topics unprompted. Only use when the conversation naturally touches related subjects.",
    );
    lines.push("[/Narrative Guide]");

    return lines.join("\n");
  } catch {
    return "";
  }
}
