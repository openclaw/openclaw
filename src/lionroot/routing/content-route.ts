/**
 * Content-based agent routing.
 *
 * Uses fast-path URL patterns and LLM classification (via Ollama)
 * to route inbound messages to the most appropriate agent based
 * on message content rather than sender/channel bindings.
 */
import type { OpenClawConfig } from "../../config/config.js";
import { logDebug } from "../../logger.js";
import { runExec } from "../../process/exec.js";
import { buildAgentSessionKey, pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import type { InvestigationConfig } from "../config/content-routing-schema.js";
import { resolveWithStickiness, type ContentConfidence } from "./content-session-sticky.js";

export type RecognizedContentRouteResult = {
  kind: "recognized";
  agentId: string;
  category?: string;
  confidence: ContentConfidence;
  reason: string;
};

export type AbstainedContentRouteResult = {
  kind: "abstain";
  confidence: "low";
  reason: string;
};

export type ContentRouteResult = RecognizedContentRouteResult | AbstainedContentRouteResult;

export type ContentRoutingConfig = {
  enabled: boolean;
  model?: string;
  ollamaUrl?: string;
  stickyTimeoutMs?: number;
  defaultAgentId?: string;
  agents: Record<string, string>;
  foodImageIntake?: {
    endpointUrl: string;
    bearerToken: string;
    timeoutMs?: number;
  };
  investigation?: InvestigationConfig;
};

const DEFAULT_MODEL = "qwen3:14b";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_STICKY_TIMEOUT_MS = 600_000; // 10 minutes

// URL extraction regex — matches http/https URLs
export const URL_RE = /https?:\/\/[^\s<>)"']+/gi;

// X/Twitter URL patterns
export const TWITTER_STATUS_RE = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i;

// GitHub URL pattern
const GITHUB_RE = /github\.com\//i;
export const MEAL_INDICATOR_RE =
  /\b(breakfast|lunch|dinner|snack|brunch|meal|ate|eating|food|calories|macros|protein|intake|nutrition|prep|smoothie|shake|coffee|supplements|recipe|cooking|cooked)\b/i;

const HEALTH_TAG_PATTERNS: Array<{
  pattern: RegExp;
  category?: string;
  reason: string;
}> = [
  { pattern: /^\s*health\s*:/i, category: "health", reason: "fast-path: health tag" },
  { pattern: /^\s*recovery\s*:/i, category: "health", reason: "fast-path: recovery tag" },
  { pattern: /^\s*sleep\s*:/i, category: "health", reason: "fast-path: sleep tag" },
  { pattern: /^\s*workout\s*:/i, category: "fitness", reason: "fast-path: workout tag" },
  { pattern: /^\s*\[liev\]/i, reason: "fast-path: [liev]" },
  { pattern: /^\s*liev\s*:/i, reason: "fast-path: liev prefix" },
];

const INVESTIGATION_TAG_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /^\s*investigate\s*:/i, reason: "fast-path: investigate tag" },
  { pattern: /^\s*research\s*:/i, reason: "fast-path: research tag" },
  { pattern: /^\s*(?:please\s+)?look\s+into\s*:/i, reason: "fast-path: look into tag" },
  { pattern: /^\s*(?:please\s+)?dig\s+into\s*:/i, reason: "fast-path: dig into tag" },
  {
    pattern: /^\s*(?:can\s+you\s+|could\s+you\s+)?(?:look|dig)\s+into\b/i,
    reason: "fast-path: investigation request",
  },
  {
    pattern: /^\s*(?:can\s+you\s+|could\s+you\s+)?(?:research|investigate)\b/i,
    reason: "fast-path: research request",
  },
];

export function isRecognizedContentRoute(
  result: ContentRouteResult | null | undefined,
): result is RecognizedContentRouteResult {
  return Boolean(result && result.kind === "recognized");
}

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
    defaultAgentId: typeof cr.defaultAgentId === "string" ? cr.defaultAgentId.trim() : undefined,
    agents,
    foodImageIntake: cr.foodImageIntake
      ? {
          endpointUrl: cr.foodImageIntake.endpointUrl,
          bearerToken: cr.foodImageIntake.bearerToken,
          timeoutMs: cr.foodImageIntake.timeoutMs,
        }
      : undefined,
    investigation: cr.investigation
      ? {
          enabled: cr.investigation.enabled,
          maxSteps: cr.investigation.maxSteps,
          maxDurationMs: cr.investigation.maxDurationMs,
          maxTokens: cr.investigation.maxTokens,
          promotionThreshold: cr.investigation.promotionThreshold,
          defaultAgentId:
            typeof cr.investigation.defaultAgentId === "string"
              ? cr.investigation.defaultAgentId.trim()
              : undefined,
        }
      : undefined,
  };
}

/**
 * Fast-path content routing — pattern matching without LLM.
 * Returns a result if a URL pattern matches, null otherwise.
 */
export function isInvestigationClassification(
  result: ContentRouteResult | null | undefined,
): result is RecognizedContentRouteResult {
  return Boolean(result && result.kind === "recognized" && result.category === "investigate");
}

export function resolveInvestigationFastPath(opts: {
  text: string;
  investigationEnabled: boolean;
  agentId?: string;
}): ContentRouteResult | null {
  if (!opts.investigationEnabled) {
    return null;
  }
  const trimmedAgentId = opts.agentId?.trim();
  if (!trimmedAgentId) {
    return null;
  }
  for (const tagPattern of INVESTIGATION_TAG_PATTERNS) {
    if (tagPattern.pattern.test(opts.text)) {
      return {
        kind: "recognized",
        agentId: trimmedAgentId,
        category: "investigate",
        confidence: "high",
        reason: tagPattern.reason,
      };
    }
  }
  return null;
}

export function resolveContentRouteFastPath(opts: {
  text: string;
  mediaType?: string;
}): ContentRouteResult | null {
  for (const tagPattern of HEALTH_TAG_PATTERNS) {
    if (tagPattern.pattern.test(opts.text)) {
      return {
        kind: "recognized",
        agentId: "liev",
        ...(tagPattern.category ? { category: tagPattern.category } : {}),
        confidence: "high",
        reason: tagPattern.reason,
      };
    }
  }

  if (opts.mediaType?.startsWith("image/") && MEAL_INDICATOR_RE.test(opts.text)) {
    return {
      kind: "recognized",
      agentId: "liev",
      category: "intake",
      confidence: "high",
      reason: "fast-path: food image with meal text",
    };
  }

  const urls = opts.text.match(URL_RE);
  if (!urls) {
    return null;
  }
  for (const url of urls) {
    if (GITHUB_RE.test(url)) {
      return {
        kind: "recognized",
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
 * Parse an LLM response that may contain "agent" or "agent:category".
 * Strips non-alphanumeric chars from each part.
 */
export function parseAgentCategory(raw: string): { agentId: string; category?: string } {
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    return { agentId: raw.replace(/[^a-z0-9_-]/g, "") };
  }
  const agentId = raw.slice(0, colonIdx).replace(/[^a-z0-9_-]/g, "");
  const category = raw.slice(colonIdx + 1).replace(/[^a-z0-9_-]/g, "");
  return { agentId, category: category || undefined };
}

/**
 * Classify message content using an Ollama LLM.
 * Sends a single-shot prompt asking the model to pick the best agent.
 */
export async function classifyContentWithLLM(opts: {
  text: string;
  mediaType?: string;
  attachmentText?: string;
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
  if (opts.attachmentText?.trim()) {
    messageContext += `Attached text content:\n${opts.attachmentText.trim()}\n`;
  }
  messageContext += `User message: ${opts.text}`;

  const prompt = `You are a message router. Given this inbound message, pick the ONE agent best suited to handle it.

Available agents:
${agentLines}

Message:
${messageContext}

Reply with ONLY the agent name, optionally followed by a colon and content category. Examples: "liev", "liev:intake", "cody:review", "leo:investigate". Use the "investigate" category for exploratory messages where the agent should infer what the user is looking into and do a bounded research pass. If unsure, reply "unknown".`;

  try {
    const response = await fetch(`${opts.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: {
          temperature: 0.1,
          num_predict: 20,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logDebug(`[content-route] Ollama returned ${response.status}`);
      return { kind: "abstain", confidence: "low", reason: "LLM error" };
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const rawResponse = (data.message?.content ?? "").trim().toLowerCase();
    // Parse agent:category format — split on first colon
    const parsed = parseAgentCategory(rawResponse);

    if (!parsed.agentId || parsed.agentId === "unknown" || parsed.agentId === "main") {
      return {
        kind: "abstain",
        confidence: "low",
        reason: rawResponse ? `LLM abstained: "${rawResponse}"` : "LLM abstained",
      };
    }

    if (parsed.agentId in opts.agentDescriptions) {
      // Determine confidence: if the response was clean (just agent or agent:category), high confidence
      const isClean =
        rawResponse === (parsed.category ? `${parsed.agentId}:${parsed.category}` : parsed.agentId);
      return {
        kind: "recognized",
        agentId: parsed.agentId,
        category: parsed.category,
        confidence: isClean ? "high" : "medium",
        reason: `LLM classified as ${opts.agentDescriptions[parsed.agentId]?.split(",")[0] ?? parsed.agentId}`,
      };
    }

    return {
      kind: "abstain",
      confidence: "low",
      reason: `LLM returned unrecognized: "${rawResponse}"`,
    };
  } catch (err) {
    logDebug(`[content-route] Ollama classification failed: ${String(err)}`);
    return { kind: "abstain", confidence: "low", reason: "LLM timeout/error" };
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
  if (isRecognizedContentRoute(fastPath)) {
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

  if (!isRecognizedContentRoute(llmResult)) {
    opts.logVerbose?.(`content-route: ${llmResult.reason} → abstain`);
    return llmResult;
  }

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
  if (!isRecognizedContentRoute(contentResult)) {
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
