/**
 * Content-based agent routing.
 *
 * Uses fast-path URL patterns and LLM classification (via Ollama)
 * to route inbound messages to the most appropriate agent based
 * on message content rather than sender/channel bindings.
 */
import type { OpenClawConfig } from "../config/config.js";
import { logDebug } from "../logger.js";
import { runExec } from "../process/exec.js";
import { resolveWithStickiness, type ContentConfidence } from "./content-session-sticky.js";
import { buildAgentSessionKey, pickFirstExistingAgentId } from "./resolve-route.js";

export type ContentRouteResult = {
  agentId: string;
  confidence: ContentConfidence;
  reason: string;
};

export type ContentRoutingConfig = {
  enabled: boolean;
  model?: string;
  ollamaUrl?: string;
  stickyTimeoutMs?: number;
  agents: Record<string, string>;
};

const DEFAULT_MODEL = "qwen3:14b";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_STICKY_TIMEOUT_MS = 600_000; // 10 minutes

// URL extraction regex — matches http/https URLs
const URL_RE = /https?:\/\/[^\s<>)"']+/gi;

// X/Twitter URL patterns
const TWITTER_STATUS_RE = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i;

// GitHub URL pattern
const GITHUB_RE = /github\.com\//i;

/**
 * Resolve the content routing config from OpenClawConfig.
 * Returns null if content routing is not configured or disabled.
 */
export function resolveContentRoutingConfig(cfg: OpenClawConfig): ContentRoutingConfig | null {
  const cr = cfg.agents?.contentRouting;
  if (!cr?.enabled) {
    return null;
  }
  const agents = cr.agents;
  if (!agents || Object.keys(agents).length === 0) {
    return null;
  }
  return {
    enabled: true,
    model: cr.model,
    ollamaUrl: cr.ollamaUrl,
    stickyTimeoutMs: cr.stickyTimeoutMs,
    agents,
  };
}

/**
 * Fast-path content routing — pattern matching without LLM.
 * Returns a result if a URL pattern matches, null otherwise.
 */
export function resolveContentRouteFastPath(opts: {
  text: string;
  mediaType?: string;
}): ContentRouteResult | null {
  const urls = opts.text.match(URL_RE);
  if (!urls) {
    return null;
  }
  for (const url of urls) {
    if (GITHUB_RE.test(url)) {
      return {
        agentId: "cody",
        confidence: "high",
        reason: `fast-path: GitHub URL (${url})`,
      };
    }
  }
  return null;
}

/**
 * Extract tweet text from an X/Twitter URL using `bird read`.
 * Returns the tweet text or null if extraction fails.
 */
export async function resolveTwitterContent(
  text: string,
  opts?: { timeoutMs?: number },
): Promise<{ tweetId: string; tweetText: string } | null> {
  const match = TWITTER_STATUS_RE.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const tweetId = match[1];
  try {
    const { stdout } = await runExec("bird", ["read", tweetId], {
      timeoutMs: opts?.timeoutMs ?? 10_000,
    });
    const tweetText = stdout.trim();
    if (!tweetText) {
      return null;
    }
    return { tweetId, tweetText };
  } catch {
    logDebug(`[content-route] bird read ${tweetId} failed`);
    return null;
  }
}

/**
 * Classify message content using an Ollama LLM.
 * Sends a single-shot prompt asking the model to pick the best agent.
 */
export async function classifyContentWithLLM(opts: {
  text: string;
  mediaType?: string;
  tweetText?: string;
  model: string;
  ollamaUrl: string;
  agentDescriptions: Record<string, string>;
}): Promise<ContentRouteResult> {
  const agentLines = Object.entries(opts.agentDescriptions)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join("\n");

  let messageContext = "";
  if (opts.tweetText) {
    messageContext += `Tweet content: ${opts.tweetText}\n`;
  }
  if (opts.mediaType) {
    messageContext += `The message includes a ${opts.mediaType} attachment.\n`;
  }
  messageContext += `User message: ${opts.text}`;

  const prompt = `You are a message router. Given this inbound message, pick the ONE agent best suited to handle it.

Available agents:
${agentLines}

Message:
${messageContext}

Reply with ONLY the agent name (lowercase, no explanation). If unsure, reply "main".`;

  try {
    const response = await fetch(`${opts.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 20,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logDebug(`[content-route] Ollama returned ${response.status}`);
      return { agentId: "main", confidence: "low", reason: "LLM error" };
    }

    const data = (await response.json()) as { response?: string };
    const rawResponse = (data.response ?? "").trim().toLowerCase();
    // Extract just the agent name — strip any extra text/punctuation
    const agentId = rawResponse.replace(/[^a-z0-9_-]/g, "");

    if (agentId && agentId in opts.agentDescriptions) {
      // Determine confidence: if the response was just the agent name, high confidence
      const isClean = rawResponse === agentId;
      return {
        agentId,
        confidence: isClean ? "high" : "medium",
        reason: `LLM classified as ${opts.agentDescriptions[agentId]?.split(",")[0] ?? agentId}`,
      };
    }

    return {
      agentId: "main",
      confidence: "low",
      reason: `LLM returned unrecognized: "${rawResponse}"`,
    };
  } catch (err) {
    logDebug(`[content-route] Ollama classification failed: ${String(err)}`);
    return { agentId: "main", confidence: "low", reason: "LLM timeout/error" };
  }
}

/**
 * Main orchestrator: fast-path → Twitter expansion → LLM classification → stickiness.
 *
 * Returns null if content routing should not override the structural route
 * (e.g., for group chats, which use binding-based routing).
 */
export async function resolveContentRouteWithStickiness(opts: {
  cfg: ContentRoutingConfig;
  text: string;
  mediaType?: string;
  peer: string;
  isGroup: boolean;
  logVerbose?: (msg: string) => void;
}): Promise<ContentRouteResult | null> {
  // Skip content routing for group chats — they rely on structural bindings
  if (opts.isGroup) {
    return null;
  }

  const text = opts.text.trim();
  if (!text) {
    return null;
  }

  const model = opts.cfg.model ?? DEFAULT_MODEL;
  const ollamaUrl = opts.cfg.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const stickyTimeoutMs = opts.cfg.stickyTimeoutMs ?? DEFAULT_STICKY_TIMEOUT_MS;

  // 1. Fast-path: URL pattern matching (no LLM, <1ms)
  const fastPath = resolveContentRouteFastPath({ text, mediaType: opts.mediaType });
  if (fastPath) {
    const finalAgentId = resolveWithStickiness({
      peer: opts.peer,
      newAgentId: fastPath.agentId,
      newConfidence: fastPath.confidence,
      stickyTimeoutMs,
    });
    const result = { ...fastPath, agentId: finalAgentId };
    opts.logVerbose?.(`content-route: ${result.reason} → ${result.agentId}`);
    return result;
  }

  // 2. Twitter/X URL expansion — resolve tweet text for classification
  let tweetText: string | undefined;
  if (TWITTER_STATUS_RE.test(text)) {
    const tweet = await resolveTwitterContent(text);
    if (tweet) {
      tweetText = tweet.tweetText;
      opts.logVerbose?.(`content-route: resolved tweet ${tweet.tweetId}`);
    }
  }

  // 3. LLM classification via Ollama
  const llmResult = await classifyContentWithLLM({
    text,
    mediaType: opts.mediaType,
    tweetText,
    model,
    ollamaUrl,
    agentDescriptions: opts.cfg.agents,
  });

  // 4. Apply session stickiness
  const finalAgentId = resolveWithStickiness({
    peer: opts.peer,
    newAgentId: llmResult.agentId,
    newConfidence: llmResult.confidence,
    stickyTimeoutMs,
  });

  const result = { ...llmResult, agentId: finalAgentId };
  opts.logVerbose?.(`content-route: ${result.reason} → ${result.agentId}`);
  return result;
}

/**
 * Apply content-based routing override to an existing route.
 * Returns the overridden route fields or null if no override applies.
 */
export async function applyContentRouteOverride(params: {
  cfg: OpenClawConfig;
  contentRoutingCfg: ContentRoutingConfig;
  text: string;
  mediaType?: string;
  peer: string;
  isGroup: boolean;
  accountId: string;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  logVerbose?: (msg: string) => void;
}): Promise<{
  agentId: string;
  sessionKey: string;
  matchedBy: "content";
} | null> {
  const contentResult = await resolveContentRouteWithStickiness({
    cfg: params.contentRoutingCfg,
    text: params.text,
    mediaType: params.mediaType,
    peer: params.peer,
    isGroup: params.isGroup,
    logVerbose: params.logVerbose,
  });
  if (!contentResult) {
    return null;
  }

  const resolvedAgentId = pickFirstExistingAgentId(params.cfg, contentResult.agentId);
  const sessionKey = buildAgentSessionKey({
    agentId: resolvedAgentId,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peer,
    },
    dmScope: params.dmScope,
  }).toLowerCase();

  return {
    agentId: resolvedAgentId,
    sessionKey,
    matchedBy: "content",
  };
}
