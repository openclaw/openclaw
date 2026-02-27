/**
 * Keyword-based agent route override for single-account channels (WhatsApp, Telegram).
 * When message body matches configured keywords, route to the corresponding agent instead.
 *
 * Config: workspace/audit/agent_switch_keywords.json
 * Format: { "agentId": ["keyword1", "keyword2", ...] }
 * Keywords are matched case-insensitively at start of message (after optional whitespace).
 *
 * RippleJay: "Bolt", "@Bolt", "执行" → action agent
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { buildAgentSessionKey } from "./resolve-route.js";
import type { ResolvedAgentRoute } from "./resolve-route.js";
import { buildAgentMainSessionKey } from "./session-key.js";
import { DEFAULT_ACCOUNT_ID } from "./session-key.js";

type SwitchKeywordsConfig = Record<string, string[]>;

let cachedConfig: SwitchKeywordsConfig | null = null;
let cachedConfigPath: string | null = null;

function loadSwitchKeywordsConfig(workspaceDir: string | undefined): SwitchKeywordsConfig | null {
  if (!workspaceDir) {
    return null;
  }
  const configPath = path.join(workspaceDir, "audit", "agent_switch_keywords.json");
  if (configPath === cachedConfigPath && cachedConfig !== undefined) {
    return cachedConfig;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cachedConfig = parsed as SwitchKeywordsConfig;
      cachedConfigPath = configPath;
      return cachedConfig;
    }
  } catch {
    cachedConfig = null;
    cachedConfigPath = configPath;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordPattern(keywords: string[]): RegExp | null {
  if (keywords.length === 0) {
    return null;
  }
  const escaped = keywords.map(escapeRegex).join("|");
  try {
    return new RegExp(`^\\s*(${escaped})(\\s|$)`, "i");
  } catch {
    return null;
  }
}

/**
 * If message body matches any agent's switch keywords and that agent is bound to the channel,
 * return an overridden route. Otherwise return the original route.
 */
export function maybeOverrideRouteByKeywords(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  body: string;
  channel: string;
  peer?: { kind: string; id: string } | null;
}): ResolvedAgentRoute {
  const { cfg, route, body, channel, peer } = params;
  const text = (body ?? "").trim();
  if (!text) {
    return route;
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, route.agentId);
  const config = loadSwitchKeywordsConfig(workspaceDir);
  if (!config || Object.keys(config).length === 0) {
    return route;
  }

  const bindings = cfg.bindings ?? [];
  const channelNorm = channel.trim().toLowerCase();

  for (const [agentId, keywords] of Object.entries(config)) {
    if (!Array.isArray(keywords) || keywords.length === 0) {
      continue;
    }
    const isBound = bindings.some(
      (b) =>
        (b.agentId ?? "").trim().toLowerCase() === agentId.toLowerCase() &&
        (b.match?.channel ?? "").trim().toLowerCase() === channelNorm,
    );
    if (!isBound) {
      continue;
    }

    const pattern = buildKeywordPattern(keywords);
    if (!pattern || !pattern.test(text)) {
      continue;
    }

    const agentExists = (cfg.agents?.list ?? []).some(
      (a) => (a.id ?? "").trim().toLowerCase() === agentId.toLowerCase(),
    );
    if (!agentExists) {
      continue;
    }

    const accountId = route.accountId ?? DEFAULT_ACCOUNT_ID;
    const sessionKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: peer ? { kind: peer.kind as "direct" | "group", id: peer.id } : null,
    }).toLowerCase();
    const mainSessionKey = buildAgentMainSessionKey({
      agentId,
      mainKey: "main",
    }).toLowerCase();

    logVerbose(
      `[routing] keyword override: "${text.slice(0, 30)}..." → agent=${agentId} (matched: ${keywords.join("|")})`,
    );

    return {
      agentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      matchedBy: "binding.channel",
    };
  }

  return route;
}
