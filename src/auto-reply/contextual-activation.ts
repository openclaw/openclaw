import fs from "node:fs";
import path from "node:path";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId, resolveModelRefFromString } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { resolveHomeDir } from "../utils.js";

export type ScheduleRule = {
  /** Time range in "HH:MM-HH:MM" format (e.g. "00:00-08:00"). Supports overnight wrap (e.g. "23:00-06:00"). */
  time: string;
  /** Override baseRate during this time window. */
  baseRate: number;
};

export type ContextualActivationConfig = {
  /** Model reference in "provider/model" format (e.g. "openrouter/meta-llama/llama-3.1-8b-instruct:free"). */
  model: string;
  /** Fallback models tried in order if the primary model fails. */
  fallbacks?: string[];
  /** Fully replace the default peeking (join) decision prompt. */
  prompt?: string;
  /** Extra rules appended to the default peeking prompt (ignored when `prompt` is set). */
  promptExtra?: string;
  /** Fully replace the default disengage decision prompt. */
  disengagePrompt?: string;
  /** Extra rules appended to the default disengage prompt (ignored when `disengagePrompt` is set). */
  disengagePromptExtra?: string;
  /** Maximum recent messages to include in the decision context. Default: 15. */
  contextMessages?: number;
  /** Base probability (0-1) of even calling the decision model when peeking. Default: 1. */
  baseRate?: number;
  /** Time-based baseRate overrides. First matching rule wins. */
  schedule?: ScheduleRule[];
  /** IANA timezone for schedule rules (e.g. "Asia/Singapore", "America/New_York"). Defaults to system local time. */
  timezone?: string;
  /** Fallback timeout (seconds) after which engaged mode auto-expires if no new messages arrive. Default: 300. */
  engagedTimeout?: number;
};

export type GroupHistoryMessage = {
  sender: string;
  body: string;
  timestamp?: number;
  /** Local file paths of images attached to this message. */
  imagePaths?: string[];
  /** Unique message ID within the group. */
  messageId?: string;
  /** ID of the message this is replying to. */
  replyToId?: string;
  /** Body of the replied-to message (for context when the original is not in recent history). */
  replyToBody?: string;
  /** Sender of the replied-to message. */
  replyToSender?: string;
};

// ---------------------------------------------------------------------------
// Decision history — per-group record of recent decisions fed back into prompt
// ---------------------------------------------------------------------------

type DecisionRecord = {
  timestamp: number;
  mode: "peeking" | "engaged";
  decision: "join" | "stay" | "disengage" | "skip";
  reason: string;
  model: string;
  durationMs: number;
  sender?: string;
  body?: string;
};

const MAX_DECISION_HISTORY = 8;

/** Per-group decision history. Keyed by groupHistoryKey. */
const decisionHistories = new Map<string, DecisionRecord[]>();

function recordDecision(groupKey: string, record: DecisionRecord) {
  let history = decisionHistories.get(groupKey);
  if (!history) {
    history = [];
    decisionHistories.set(groupKey, history);
  }
  history.push(record);
  if (history.length > MAX_DECISION_HISTORY) {
    history.splice(0, history.length - MAX_DECISION_HISTORY);
  }
  writeDecisionLog(groupKey, record);
}

// ---------------------------------------------------------------------------
// Structured decision log — JSONL files per group under ~/.openclaw/logs/contextual-activation/
// ---------------------------------------------------------------------------

let logBaseDir: string | undefined;

function resolveLogDir(groupKey: string): string | undefined {
  if (logBaseDir === undefined) {
    const home = resolveHomeDir();
    logBaseDir = home ? path.join(home, ".openclaw", "logs", "contextual-activation") : "";
  }
  if (!logBaseDir) {
    return undefined;
  }
  // Sanitize groupKey for filesystem (replace colons, slashes)
  const safeKey = groupKey.replace(/[:/\\]/g, "_");
  return path.join(logBaseDir, safeKey);
}

function writeDecisionLog(groupKey: string, record: DecisionRecord) {
  try {
    const dir = resolveLogDir(groupKey);
    if (!dir) {
      return;
    }
    fs.mkdirSync(dir, { recursive: true });

    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    const logFile = path.join(dir, `${date}.jsonl`);

    const entry = {
      t: new Date(record.timestamp).toISOString(),
      mode: record.mode,
      decision: record.decision,
      reason: record.reason,
      model: record.model,
      ms: record.durationMs,
      ...(record.sender ? { sender: record.sender } : {}),
      ...(record.body ? { body: record.body } : {}),
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort logging, don't break the decision flow
  }
}

function formatDecisionHistory(groupKey: string): string {
  const history = decisionHistories.get(groupKey);
  if (!history || history.length === 0) {
    return "(no previous decisions)";
  }
  return history
    .map((r) => {
      const time = new Date(r.timestamp).toLocaleTimeString();
      const tag =
        r.decision === "join"
          ? "JOINED conversation"
          : r.decision === "stay"
            ? "CONTINUED participating"
            : r.decision === "disengage"
              ? "DISENGAGED (went silent)"
              : "SKIPPED (stayed silent)";
      return `[${time}] ${tag} — ${r.reason}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Engagement state — per-group peeking/engaged tracking
// ---------------------------------------------------------------------------

/** Per-group engagement state, tracked in memory. */
export type EngagementState = {
  mode: "peeking" | "engaged";
  /** Timestamp (ms) when the bot last participated (sent a reply or entered engaged mode). */
  lastActivityAt: number;
  /** How many consecutive times the model said NO in peeking mode. */
  consecutiveSkips: number;
};

/** In-memory store for per-group engagement states. Keyed by groupHistoryKey. */
export const engagementStates = new Map<string, EngagementState>();

const DEFAULT_CONTEXT_MESSAGES = 15;
const DEFAULT_ENGAGED_TIMEOUT_S = 300;

// ---------------------------------------------------------------------------
// Prompts — richer than v1, include decision history and behavioral guidelines
// ---------------------------------------------------------------------------

const DEFAULT_PEEKING_PROMPT = `You are a group chat participation advisor for an AI assistant named {botName}.

You are monitoring a group chat. The assistant is currently SILENT (just observing). Your job is to decide whether the assistant should JOIN the conversation. Think like a real person lurking in a group chat — sometimes you just can't resist chiming in.

**Decision Guidelines:**
1. If the group is having an open, divergent discussion on a fun or interesting topic, consider joining — you don't need to be an expert, a lighthearted comment, reaction, or even a sticker is fine
2. If a few people are having a focused private-ish discussion, do NOT interrupt — UNLESS they hit a disagreement or a question where you could genuinely help
3. If the conversation topic is something you truly know nothing about (e.g. references to private events you have zero context for), skip it. But if you can understand the gist from the messages, that's enough to join
4. If someone seems annoyed by the assistant, lean towards NO
5. Pure noise (single-word reactions, "ok", "lol") is NOT worth joining for — but a fun or casual topic that people are actually discussing IS worth it
6. Be a natural group member: occasionally drop a comment on interesting topics like news, animals, tech, culture, food, etc. Don't be a wallflower that only speaks when spoken to
7. If someone is asking a question or the topic is unresolved, lean towards YES
8. When someone shares an image: ignore random/unrelated images (e.g. anime pics with no context), but if it's a funny meme or a picture that sparks discussion, consider joining even without prior context

**Output format:**
Respond with a JSON object (no markdown fencing):
{"decision":"YES","reason":"brief reason"}
or
{"decision":"NO","reason":"brief reason"}`;

const DEFAULT_DISENGAGE_PROMPT = `You are a group chat participation advisor for an AI assistant named {botName}.

The assistant is currently PARTICIPATING in this conversation. Your job is to decide whether the assistant should CONTINUE or DISENGAGE (go back to silently observing).

**Decision Guidelines:**
1. If the topic has naturally concluded or shifted away, DISENGAGE
2. If someone asked the assistant a follow-up question, CONTINUE
3. If the assistant has already given sufficient input and further replies would feel excessive, DISENGAGE
4. If the group has gone quiet (no new messages for a while), DISENGAGE
5. Don't overstay — it's better to leave a bit early than to be the last one talking
6. If people are now chatting among themselves without involving the assistant, DISENGAGE

**Output format:**
Respond with a JSON object (no markdown fencing):
{"decision":"CONTINUE","reason":"brief reason"}
or
{"decision":"DISENGAGE","reason":"brief reason"}`;

export type ContextualActivationResult = {
  shouldProcess: boolean;
  engagementChanged?: boolean;
  error?: string;
  /** The decision model's reason — can be forwarded to the main agent as a hint. */
  reason?: string;
};

// ---------------------------------------------------------------------------
// Provider resolution helpers
// ---------------------------------------------------------------------------

function resolveApiKeyForProvider(cfg: OpenClawConfig, provider: string): string | undefined {
  const configKey = getCustomProviderApiKey(cfg, provider);
  if (configKey) {
    return configKey;
  }
  const envResult = resolveEnvApiKey(provider);
  return envResult?.apiKey;
}

function resolveBaseUrl(cfg: OpenClawConfig, provider: string): string | undefined {
  const normalized = normalizeProviderId(provider);
  const providerConfig = (cfg.models?.providers ?? {})[provider] as
    | { baseUrl?: string }
    | undefined;
  const configBaseUrl =
    providerConfig?.baseUrl ??
    ((cfg.models?.providers ?? {})[normalized] as { baseUrl?: string } | undefined)?.baseUrl;
  if (configBaseUrl) {
    return configBaseUrl;
  }

  const defaultBaseUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
    anthropic: "https://api.anthropic.com/v1",
    together: "https://api.together.xyz/v1",
    cerebras: "https://api.cerebras.ai/v1",
    mistral: "https://api.mistral.ai/v1",
    xai: "https://api.x.ai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
  };
  return defaultBaseUrls[normalized];
}

// ---------------------------------------------------------------------------
// Message formatting — with message IDs like MaiBot (m001, m002...)
// ---------------------------------------------------------------------------

/** Maximum depth for recursive reply chain resolution. */
const MAX_REPLY_CHAIN_DEPTH = 5;

function formatMessagesForDecision(
  messages: GroupHistoryMessage[],
  limit: number,
  allMessages?: GroupHistoryMessage[],
): string {
  const recent = messages.slice(-limit);
  if (recent.length === 0) {
    return "(no recent messages)";
  }

  // Build a lookup from messageId → display ID for messages in the visible window
  const msgIdToDisplayId = new Map<string, string>();
  recent.forEach((m, i) => {
    const displayId = `m${String(i + 1).padStart(3, "0")}`;
    if (m.messageId) {
      msgIdToDisplayId.set(m.messageId, displayId);
    }
  });

  // Build a lookup from messageId → message for the full history (for chain resolution)
  const allById = new Map<string, GroupHistoryMessage>();
  if (allMessages) {
    for (const m of allMessages) {
      if (m.messageId) {
        allById.set(m.messageId, m);
      }
    }
  }

  /**
   * Resolve the reply chain for a message whose replyToId is NOT in the visible window.
   * Returns a string like: `sender: "body" → sender2: "body2" → m003`
   * Stops when hitting a message in the visible window, running out of data, or reaching max depth.
   */
  function resolveOutOfRangeChain(
    replyToId: string,
    replyToSender?: string,
    replyToBody?: string,
  ): string {
    const parts: string[] = [];
    let currentId: string | undefined = replyToId;
    let currentSender = replyToSender;
    let currentBody = replyToBody;

    for (let depth = 0; depth < MAX_REPLY_CHAIN_DEPTH; depth++) {
      // If the current target is in the visible window, end the chain with its display ID
      if (currentId) {
        const displayId = msgIdToDisplayId.get(currentId);
        if (displayId) {
          parts.push(displayId);
          break;
        }
      }

      // Inline the content
      const sender = currentSender ?? "someone";
      const body = currentBody ?? "…";
      parts.push(`${sender}: "${body}"`);

      // Try to follow the chain deeper via the full history
      if (!currentId) {
        break;
      }
      const parent = allById.get(currentId);
      if (!parent?.replyToId) {
        break;
      }

      currentId = parent.replyToId;
      currentSender = parent.replyToSender;
      currentBody = parent.replyToBody;
    }

    return parts.join(" → ");
  }

  return recent
    .map((m, i) => {
      const id = `m${String(i + 1).padStart(3, "0")}`;
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
      const prefix = time ? `[${id}] [${time}]` : `[${id}]`;

      let replyHint = "";
      if (m.replyToId) {
        const refId = msgIdToDisplayId.get(m.replyToId);
        if (refId) {
          replyHint = ` (replying to ${refId})`;
        } else if (m.replyToSender || m.replyToBody || allById.has(m.replyToId)) {
          // Referenced message is not in the visible window — resolve the chain
          const chain = resolveOutOfRangeChain(m.replyToId, m.replyToSender, m.replyToBody);
          replyHint = ` (replying to ${chain})`;
        }
      }

      return `${prefix}${replyHint} ${m.sender}: ${m.body}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// LLM call with fallback chain
// ---------------------------------------------------------------------------

type ModelCallResult = {
  content: string;
  model: string;
  durationMs: number;
  error?: string;
};

function buildUserContent(
  text: string,
  imagePaths?: string[],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const validImages = (imagePaths ?? []).filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).size < 5 * 1024 * 1024; // skip files > 5MB
    } catch {
      return false;
    }
  });
  if (validImages.length === 0) {
    return text;
  }
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text },
  ];
  for (const imgPath of validImages.slice(0, 3)) {
    try {
      const buf = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase().replace(".", "");
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : "image/jpeg";
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    } catch {
      // Skip unreadable images
    }
  }
  return parts;
}

async function callSingleModel(params: {
  cfg: OpenClawConfig;
  modelRaw: string;
  systemPrompt: string;
  userPrompt: string;
  imagePaths?: string[];
}): Promise<ModelCallResult> {
  const start = Date.now();
  const resolved = resolveModelRefFromString({
    raw: params.modelRaw,
    defaultProvider: "openrouter",
  });
  if (!resolved) {
    return {
      content: "",
      model: params.modelRaw,
      durationMs: Date.now() - start,
      error: `Invalid model ref: ${params.modelRaw}`,
    };
  }
  const { ref } = resolved;

  const apiKey = resolveApiKeyForProvider(params.cfg, ref.provider);
  if (!apiKey) {
    return {
      content: "",
      model: params.modelRaw,
      durationMs: Date.now() - start,
      error: `No API key found for provider: ${ref.provider}`,
    };
  }

  const baseUrl = resolveBaseUrl(params.cfg, ref.provider);
  if (!baseUrl) {
    return {
      content: "",
      model: params.modelRaw,
      durationMs: Date.now() - start,
      error: `No base URL for provider: ${ref.provider}`,
    };
  }

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: ref.model,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: buildUserContent(params.userPrompt, params.imagePaths) },
        ],
        max_tokens: 100,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        content: "",
        model: params.modelRaw,
        durationMs: Date.now() - start,
        error: `${params.modelRaw} HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return {
      content: data.choices?.[0]?.message?.content?.trim() ?? "",
      model: params.modelRaw,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: "",
      model: params.modelRaw,
      durationMs: Date.now() - start,
      error: `${params.modelRaw}: ${message}`,
    };
  }
}

async function callDecisionModel(params: {
  cfg: OpenClawConfig;
  config: ContextualActivationConfig;
  systemPrompt: string;
  userPrompt: string;
  imagePaths?: string[];
}): Promise<ModelCallResult> {
  const models = [params.config.model, ...(params.config.fallbacks ?? [])];
  const errors: string[] = [];

  for (const modelRaw of models) {
    const result = await callSingleModel({
      cfg: params.cfg,
      modelRaw,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      imagePaths: params.imagePaths,
    });
    if (!result.error) {
      return result;
    }
    logVerbose(`[contextual-activation] ${modelRaw} failed: ${result.error}`);
    errors.push(result.error);
  }

  return {
    content: "",
    model: models[0],
    durationMs: 0,
    error: `All models failed: ${errors.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// Parse structured decision response
// ---------------------------------------------------------------------------

type ParsedDecision = { decision: string; reason: string };

function parseDecisionResponse(raw: string): ParsedDecision {
  // Try JSON parse first
  try {
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { decision?: string; reason?: string };
    if (parsed.decision) {
      return {
        decision: parsed.decision.toUpperCase(),
        reason: parsed.reason ?? "",
      };
    }
  } catch {
    // Fall through to text parsing
  }

  // Fallback: look for YES/NO/CONTINUE/DISENGAGE in the text
  const upper = raw.toUpperCase();
  if (upper.includes("YES")) {
    return { decision: "YES", reason: raw };
  }
  if (upper.includes("DISENGAGE")) {
    return { decision: "DISENGAGE", reason: raw };
  }
  if (upper.includes("CONTINUE")) {
    return { decision: "CONTINUE", reason: raw };
  }
  if (upper.includes("NO")) {
    return { decision: "NO", reason: raw };
  }
  return { decision: "NO", reason: raw };
}

// ---------------------------------------------------------------------------
// Engagement state helpers
// ---------------------------------------------------------------------------

function getEngagement(groupKey: string): EngagementState {
  const existing = engagementStates.get(groupKey);
  if (existing) {
    return existing;
  }
  const state: EngagementState = { mode: "peeking", lastActivityAt: 0, consecutiveSkips: 0 };
  engagementStates.set(groupKey, state);
  return state;
}

function checkEngagedTimeout(state: EngagementState, timeoutS: number): boolean {
  if (state.mode !== "engaged") {
    return false;
  }
  const elapsed = Date.now() - state.lastActivityAt;
  return elapsed > timeoutS * 1000;
}

/** Parse "HH:MM" to minutes since midnight. */
function parseTimeToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) {
    return null;
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Check if `nowMin` falls within a time range (supports overnight wrap). */
function inTimeRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin <= endMin;
  }
  // Overnight wrap: e.g. 23:00-06:00
  return nowMin >= startMin || nowMin <= endMin;
}

/** Resolve baseRate from schedule rules, falling back to config.baseRate. */
function resolveScheduledBaseRate(config: ContextualActivationConfig): number {
  const fallback = config.baseRate ?? 1;
  const rules = config.schedule;
  if (!rules || rules.length === 0) {
    return fallback;
  }

  const now = new Date();
  let hours: number;
  let minutes: number;
  if (config.timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: config.timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(now);
      hours = Number(parts.find((p) => p.type === "hour")?.value ?? now.getHours());
      minutes = Number(parts.find((p) => p.type === "minute")?.value ?? now.getMinutes());
    } catch {
      // Invalid timezone — fall back to local
      hours = now.getHours();
      minutes = now.getMinutes();
    }
  } else {
    hours = now.getHours();
    minutes = now.getMinutes();
  }
  const nowMin = hours * 60 + minutes;

  for (const rule of rules) {
    const parts = rule.time.split("-");
    if (parts.length !== 2) {
      continue;
    }
    const start = parseTimeToMinutes(parts[0]);
    const end = parseTimeToMinutes(parts[1]);
    if (start === null || end === null) {
      continue;
    }
    if (inTimeRange(nowMin, start, end)) {
      return rule.baseRate;
    }
  }
  return fallback;
}

/** Compute effective baseRate with consecutive-skip decay. */
function effectiveBaseRate(baseRate: number, consecutiveSkips: number): number {
  if (consecutiveSkips <= 0) {
    return baseRate;
  }
  // Decay: after 5 consecutive skips, effective rate is ~50% of baseRate
  // after 10, ~33%. Asymptotically approaches 0 but never reaches it.
  return baseRate / (1 + consecutiveSkips * 0.1);
}

/** Mark the bot as having just participated — call this after sending a reply. */
export function touchEngagement(groupKey: string) {
  const state = engagementStates.get(groupKey);
  if (state?.mode === "engaged") {
    state.lastActivityAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function shouldParticipateInGroup(params: {
  cfg: OpenClawConfig;
  config: ContextualActivationConfig;
  recentMessages: GroupHistoryMessage[];
  currentMessage: GroupHistoryMessage;
  groupKey: string;
  botName?: string;
}): Promise<ContextualActivationResult> {
  const { cfg, config, recentMessages, currentMessage, groupKey, botName } = params;
  const contextLimit = config.contextMessages ?? DEFAULT_CONTEXT_MESSAGES;
  const baseRate = resolveScheduledBaseRate(config);
  const engagedTimeout = config.engagedTimeout ?? DEFAULT_ENGAGED_TIMEOUT_S;

  const state = getEngagement(groupKey);

  // Check for engaged timeout fallback
  if (checkEngagedTimeout(state, engagedTimeout)) {
    logVerbose(
      `[contextual-activation] ${groupKey}: engaged timeout (${engagedTimeout}s), returning to peeking`,
    );
    state.mode = "peeking";
    recordDecision(groupKey, {
      timestamp: Date.now(),
      mode: "engaged",
      decision: "disengage",
      reason: `timeout after ${engagedTimeout}s`,
      model: "timeout",
      durationMs: 0,
      sender: currentMessage.sender,
      body: currentMessage.body,
    });
  }

  const allMessages = [...recentMessages, currentMessage];
  const chatContent = formatMessagesForDecision(allMessages, contextLimit, allMessages);
  const botLabel = botName ?? "AI Assistant";
  const historyBlock = formatDecisionHistory(groupKey);

  if (state.mode === "engaged") {
    // --- ENGAGED MODE: ask if we should disengage ---
    const baseDisengage =
      config.disengagePrompt ??
      (config.disengagePromptExtra
        ? `${DEFAULT_DISENGAGE_PROMPT}\n\n**Additional rules:**\n${config.disengagePromptExtra}`
        : DEFAULT_DISENGAGE_PROMPT);
    const systemPrompt = baseDisengage.replace(/\{botName\}/g, botLabel);
    const userPrompt = [
      "**Recent group chat messages:**",
      chatContent,
      "",
      "**Your previous decisions in this group:**",
      historyBlock,
      "",
      "Should the assistant continue participating or disengage?",
    ].join("\n");

    const result = await callDecisionModel({
      cfg,
      config,
      systemPrompt,
      userPrompt,
      imagePaths: currentMessage.imagePaths,
    });
    if (result.error) {
      logVerbose(
        `[contextual-activation] ${groupKey}: disengage check error: ${result.error} (${result.durationMs}ms)`,
      );
      // On error, stay engaged (fail-open for ongoing conversations)
      return { shouldProcess: true };
    }

    const parsed = parseDecisionResponse(result.content);

    if (parsed.decision === "DISENGAGE") {
      const reason = parsed.reason || "model decided to disengage";
      logVerbose(
        `[contextual-activation] ${groupKey}: DISENGAGE (${result.model}, ${result.durationMs}ms) — ${reason}`,
      );
      recordDecision(groupKey, {
        timestamp: Date.now(),
        mode: "engaged",
        decision: "disengage",
        reason,
        model: result.model,
        durationMs: result.durationMs,
        sender: currentMessage.sender,
        body: currentMessage.body,
      });
      state.mode = "peeking";
      state.lastActivityAt = 0;
      state.consecutiveSkips = 0;
      return { shouldProcess: false, engagementChanged: true };
    }

    const reason = parsed.reason || "continuing";
    logVerbose(
      `[contextual-activation] ${groupKey}: CONTINUE (${result.model}, ${result.durationMs}ms) — ${reason}`,
    );
    recordDecision(groupKey, {
      timestamp: Date.now(),
      mode: "engaged",
      decision: "stay",
      reason,
      model: result.model,
      durationMs: result.durationMs,
      sender: currentMessage.sender,
      body: currentMessage.body,
    });
    state.lastActivityAt = Date.now();
    return { shouldProcess: true, reason };
  }

  // --- PEEKING MODE ---

  // Fast path: if baseRate is 0, never participate
  if (baseRate <= 0) {
    return { shouldProcess: false };
  }

  // Probabilistic pre-filter with consecutive-skip decay
  const rate = effectiveBaseRate(baseRate, state.consecutiveSkips);
  if (rate < 1 && Math.random() > rate) {
    return { shouldProcess: false };
  }

  const basePeeking =
    config.prompt ??
    (config.promptExtra
      ? `${DEFAULT_PEEKING_PROMPT}\n\n**Additional rules:**\n${config.promptExtra}`
      : DEFAULT_PEEKING_PROMPT);
  const systemPrompt = basePeeking.replace(/\{botName\}/g, botLabel);
  const userPrompt = [
    "**Recent group chat messages:**",
    chatContent,
    "",
    "**Your previous decisions in this group:**",
    historyBlock,
    "",
    "Should the assistant participate?",
  ].join("\n");

  const result = await callDecisionModel({ cfg, config, systemPrompt, userPrompt });
  if (result.error) {
    logVerbose(
      `[contextual-activation] ${groupKey}: peeking error: ${result.error} (${result.durationMs}ms)`,
    );
    return { shouldProcess: false, error: result.error };
  }

  const parsed = parseDecisionResponse(result.content);

  if (parsed.decision === "YES") {
    const reason = parsed.reason || "model decided to join";
    logVerbose(
      `[contextual-activation] ${groupKey}: JOIN -> engaged (${result.model}, ${result.durationMs}ms) — ${reason}`,
    );
    recordDecision(groupKey, {
      timestamp: Date.now(),
      mode: "peeking",
      decision: "join",
      reason,
      model: result.model,
      durationMs: result.durationMs,
      sender: currentMessage.sender,
      body: currentMessage.body,
    });
    state.mode = "engaged";
    state.lastActivityAt = Date.now();
    state.consecutiveSkips = 0;
    return { shouldProcess: true, engagementChanged: true, reason };
  }

  const reason = parsed.reason || "not relevant";
  state.consecutiveSkips++;
  logVerbose(
    `[contextual-activation] ${groupKey}: SKIP #${state.consecutiveSkips} (${result.model}, ${result.durationMs}ms, effectiveRate=${rate.toFixed(2)}) — ${reason}`,
  );
  recordDecision(groupKey, {
    timestamp: Date.now(),
    mode: "peeking",
    decision: "skip",
    reason,
    model: result.model,
    durationMs: result.durationMs,
    sender: currentMessage.sender,
    body: currentMessage.body,
  });
  return { shouldProcess: false };
}
