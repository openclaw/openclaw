import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId, resolveModelRefFromString } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { resolveHomeDir } from "../utils.js";

// ---------------------------------------------------------------------------
// Identity context loader — reads SOUL.md / IDENTITY.md from workspace
// ---------------------------------------------------------------------------

let cachedIdentityContext: string | null = null;

function loadIdentityContext(cfg: OpenClawConfig): string {
  if (cachedIdentityContext !== null) {
    return cachedIdentityContext;
  }
  try {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const parts: string[] = [];
    for (const filename of [
      "SOUL.md",
      "AGENTS.md",
      "IDENTITY.md",
      "USER.md",
      "MEMORY.md",
      "TOOLS.md",
      "HEARTBEAT.md",
    ]) {
      const filePath = path.join(workspaceDir, filename);
      try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (content) {
          parts.push(`## ${filename}\n\n${content}`);
        }
      } catch {
        // File doesn't exist, skip
      }
    }
    cachedIdentityContext = parts.length > 0 ? parts.join("\n\n") : "";
  } catch {
    cachedIdentityContext = "";
  }
  return cachedIdentityContext;
}

/** Reset the cached identity context (e.g. after config reload). */
export function resetIdentityContextCache() {
  cachedIdentityContext = null;
}

export type ScheduleRule = {
  /** Time range in "HH:MM-HH:MM" format (e.g. "00:00-08:00"). Supports overnight wrap (e.g. "23:00-06:00"). */
  time: string;
  /** Override baseRate during this time window. */
  baseRate: number;
};

export type MentionFilterConfig = {
  /** Enable filtering mentions/replies through the decision model. Default: false. */
  enabled?: boolean;
  /** Fully replace the default mention filter prompt. */
  prompt?: string;
  /** Extra rules appended to the default mention filter prompt (ignored when `prompt` is set). */
  promptExtra?: string;
  /** Probability (0-1) of calling the decision model on mentions/replies. Default: 1. */
  rate?: number;
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
  /** Filter mentions/replies through the decision model instead of always responding. */
  mentionFilter?: MentionFilterConfig;
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
// Suppressed users — persistent per-group registry of users who expressed annoyance
// ---------------------------------------------------------------------------

export type SuppressedUserEntry = {
  userId: string;
  reason: string;
  detectedAt: number;
  lastSeenAt: number;
  count: number;
};

type SuppressedUsersData = Record<string, Record<string, SuppressedUserEntry>>;

let suppressedUsersCache: SuppressedUsersData | null = null;

function getSuppressedUsersPath(): string {
  const home = resolveHomeDir() ?? "";
  return path.join(home, ".openclaw", "data", "contextual-activation", "suppressed-users.json");
}

function loadSuppressedUsers(): SuppressedUsersData {
  if (suppressedUsersCache) {
    return suppressedUsersCache;
  }
  try {
    const data = fs.readFileSync(getSuppressedUsersPath(), "utf-8");
    suppressedUsersCache = JSON.parse(data) as SuppressedUsersData;
    return suppressedUsersCache;
  } catch {
    suppressedUsersCache = {};
    return suppressedUsersCache;
  }
}

function saveSuppressedUsers(data: SuppressedUsersData) {
  suppressedUsersCache = data;
  const filePath = getSuppressedUsersPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort persistence
  }
}

function recordSuppressedUser(groupKey: string, userId: string, reason: string) {
  const data = loadSuppressedUsers();
  if (!data[groupKey]) {
    data[groupKey] = {};
  }
  const existing = data[groupKey][userId];
  if (existing) {
    existing.count++;
    existing.lastSeenAt = Date.now();
    existing.reason = reason;
  } else {
    data[groupKey][userId] = {
      userId,
      reason,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      count: 1,
    };
  }
  saveSuppressedUsers(data);
  logVerbose(
    `[contextual-activation] ${groupKey}: recorded negative feedback for user ${userId} — ${reason}`,
  );
}

function getSuppressedEntry(groupKey: string, userId: string): SuppressedUserEntry | undefined {
  const data = loadSuppressedUsers();
  return data[groupKey]?.[userId];
}

/** Extract userId from sender label like "Name (@user) id:12345". */
function extractSenderId(sender: string): string | undefined {
  const match = /id:(\d+)/.exec(sender);
  return match?.[1];
}

/** Get all suppressed users, optionally filtered by group. */
export function getAllSuppressedUsers(groupKey?: string): SuppressedUsersData {
  const data = loadSuppressedUsers();
  if (groupKey) {
    return data[groupKey] ? { [groupKey]: data[groupKey] } : {};
  }
  return data;
}

/** Remove a suppressed user from a group. Returns true if found and removed. */
export function removeSuppressedUser(groupKey: string, userId: string): boolean {
  const data = loadSuppressedUsers();
  if (data[groupKey]?.[userId]) {
    delete data[groupKey][userId];
    if (Object.keys(data[groupKey]).length === 0) {
      delete data[groupKey];
    }
    saveSuppressedUsers(data);
    return true;
  }
  return false;
}

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
  messageId?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
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
      ...(record.messageId ? { msgId: record.messageId } : {}),
      ...(record.replyToId ? { replyId: record.replyToId } : {}),
      ...(record.replyToBody ? { replyBody: record.replyToBody } : {}),
      ...(record.replyToSender ? { replySender: record.replyToSender } : {}),
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
7. If someone is asking a question or the topic is unresolved, lean towards YES — but ONLY if the assistant can add genuine value. If the question is mundane, already answered by others, or just a factual exchange between group members (e.g. "can X do Y?" → "yes"), skip it. People don't need an AI parroting what someone just said
8. When someone shares an image: ignore random/unrelated images (e.g. anime pics with no context), but if it's a funny meme or a picture that sparks discussion, consider joining even without prior context
9. When someone shares a link or video (e.g. YouTube, Bilibili, articles) with just a brief caption or title, skip it — people casually share stuff in groups all the time and rarely expect a reply. Only respond if it's truly bizarre, absurdly funny, or the group is actively discussing it. Think of how real humans behave: most shared links get zero replies
10. Pay close attention to WHO is talking and the conversational dynamics: a group may have multiple parallel threads. Focus on the thread the current message belongs to, not unrelated chatter. If one person is monologuing (sending several messages with no replies from others), that's usually not worth joining — they're talking to themselves. Only join a thread where there's genuine back-and-forth between people, or where the current message clearly invites interaction
11. Mundane Q&A between group members is NOT worth joining. If people are exchanging simple factual info (e.g. "how to do X?" → "just do Y"), this is a resolved exchange — don't jump in to repeat, rephrase, or "add context". Only join if there's a genuine gap, disagreement, or if the topic is fun/interesting beyond the bare facts
12. Never join just to ask questions. If you don't know enough about the topic to contribute, stay silent. A real group member who knows nothing about a topic doesn't chime in with "oh interesting, how does that work?" — they just keep scrolling

**Output format:**
Respond with a JSON object (no markdown fencing):
{"decision":"YES","reason":"brief reason"}
or
{"decision":"NO","reason":"brief reason"}

If you notice someone in the conversation expressing annoyance, frustration, or hostility toward the assistant (e.g. "你好烦", "shut up bot", "别说话了", "要被我过滤了"), add a negativeFeedback field with their userId (from the sender label, e.g. "Name id:12345" → userId is "12345"):
{"decision":"NO","reason":"...","negativeFeedback":{"userId":"12345","reason":"what they expressed"}}`;

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
{"decision":"DISENGAGE","reason":"brief reason"}

If you notice someone expressing annoyance or hostility toward the assistant, add a negativeFeedback field:
{"decision":"DISENGAGE","reason":"...","negativeFeedback":{"userId":"12345","reason":"what they expressed"}}`;

const DEFAULT_MENTION_FILTER_PROMPT = `You are {botName}. Someone just mentioned you or replied to your message in a group chat. Decide whether you should RESPOND or IGNORE this message.

Think from your own perspective: as a member of this group, is this message directed at you? Do you need to respond?

**RESPOND — you should reply:**
1. Someone is directly asking you a question or requesting your help
2. Someone is continuing a substantive conversation with you
3. Someone is challenging, correcting, or disagreeing with you — you should defend your position or acknowledge the correction
4. Someone provides evidence (links, screenshots, quotes) that supports or refutes something you said — you should look at it and engage
5. Someone is asking you to take an action (e.g. "go search for it", "look at this link", "try again")
6. The message is short but carries a challenge or provocation (e.g. "can't you search?", "really?", "are you sure?") — sarcastic tone does NOT mean you should ignore it; address the underlying point
7. Someone shares something interesting and clearly wants your reaction

**IGNORE — you do not need to reply:**
1. A pure conversation-ender with NO new information: "ok", "got it", "thanks", "👍" — but ONLY when the topic is truly concluded
2. Someone is quoting/replying to your message but is clearly talking to someone else (check if they are addressing another person by name)
3. Someone mentioned you casually as a reference without expecting a response (e.g. "like {botName} said earlier...")
4. A single emoji reaction or sticker with no substantive content, AND the conversation has moved on

**Key principle:** Whenever someone directly engages with you — whether asking, challenging, correcting, or providing evidence — you should almost always respond. Only filter out messages that are truly content-free acknowledgments or clearly not directed at you. When in doubt, lean towards RESPOND.

**Output format:**
Respond with a JSON object (no markdown fencing):
{"decision":"RESPOND","reason":"brief reason"}
or
{"decision":"IGNORE","reason":"brief reason"}`;

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
        } else if (m.replyToSender || m.replyToBody || m.replyToId) {
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

type ParsedDecision = {
  decision: string;
  reason: string;
  negativeFeedback?: { userId: string; reason: string };
};

function parseDecisionResponse(raw: string): ParsedDecision {
  // Try JSON parse first
  try {
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      decision?: string;
      reason?: string;
      negativeFeedback?: { userId?: string; reason?: string };
    };
    if (parsed.decision) {
      const result: ParsedDecision = {
        decision: parsed.decision.toUpperCase(),
        reason: parsed.reason ?? "",
      };
      if (parsed.negativeFeedback?.userId) {
        result.negativeFeedback = {
          userId: parsed.negativeFeedback.userId,
          reason: parsed.negativeFeedback.reason ?? "",
        };
      }
      return result;
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

/** Per-group cache of the last decided messageId → result, to avoid re-deciding the same message. */
const lastDecisionByGroup = new Map<
  string,
  { messageId: string; result: ContextualActivationResult }
>();

export async function shouldParticipateInGroup(params: {
  cfg: OpenClawConfig;
  config: ContextualActivationConfig;
  recentMessages: GroupHistoryMessage[];
  currentMessage: GroupHistoryMessage;
  groupKey: string;
  botName?: string;
}): Promise<ContextualActivationResult> {
  const { currentMessage, groupKey } = params;

  // Deduplicate: if we already decided on this exact message, return the cached result.
  if (currentMessage.messageId) {
    const cached = lastDecisionByGroup.get(groupKey);
    if (cached?.messageId === currentMessage.messageId) {
      logVerbose(
        `[contextual-activation] ${groupKey}: dedup — reusing decision for #${currentMessage.messageId}`,
      );
      return cached.result;
    }
  }

  const result = await shouldParticipateInGroupImpl(params);

  // Cache the result for dedup
  if (currentMessage.messageId) {
    lastDecisionByGroup.set(groupKey, { messageId: currentMessage.messageId, result });
  }
  return result;
}

async function shouldParticipateInGroupImpl(params: {
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
      messageId: currentMessage.messageId,
      replyToId: currentMessage.replyToId,
      replyToBody: currentMessage.replyToBody,
      replyToSender: currentMessage.replyToSender,
    });
  }

  const allMessages = [...recentMessages, currentMessage];
  const chatContent = formatMessagesForDecision(allMessages, contextLimit, allMessages);
  const botLabel = botName ?? "AI Assistant";
  const historyBlock = formatDecisionHistory(groupKey);

  // Load identity context once for all decision paths
  const identityContext = loadIdentityContext(cfg);

  if (state.mode === "engaged") {
    // --- ENGAGED MODE: ask if we should disengage ---
    const baseDisengage =
      config.disengagePrompt ??
      (config.disengagePromptExtra
        ? `${DEFAULT_DISENGAGE_PROMPT}\n\n**Additional rules:**\n${config.disengagePromptExtra}`
        : DEFAULT_DISENGAGE_PROMPT);
    const disengageWithIdentity = identityContext
      ? `${identityContext}\n\n---\n\n${baseDisengage}`
      : baseDisengage;
    const systemPrompt = disengageWithIdentity.replace(/\{botName\}/g, botLabel);
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

    // Handle negative feedback detection in engaged mode too
    if (parsed.negativeFeedback) {
      recordSuppressedUser(
        groupKey,
        parsed.negativeFeedback.userId,
        parsed.negativeFeedback.reason,
      );
    }

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
      messageId: currentMessage.messageId,
      replyToId: currentMessage.replyToId,
      replyToBody: currentMessage.replyToBody,
      replyToSender: currentMessage.replyToSender,
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
  const peekingWithIdentity = identityContext
    ? `${identityContext}\n\n---\n\n${basePeeking}`
    : basePeeking;
  const systemPrompt = peekingWithIdentity.replace(/\{botName\}/g, botLabel);

  // Check if the current sender is suppressed (previously expressed annoyance)
  const senderId = extractSenderId(currentMessage.sender);
  const suppressedEntry = senderId ? getSuppressedEntry(groupKey, senderId) : undefined;

  const userPromptParts = [
    "**Recent group chat messages:**",
    chatContent,
    "",
    "**Your previous decisions in this group:**",
    historyBlock,
  ];

  if (suppressedEntry) {
    const daysSince = Math.floor((Date.now() - suppressedEntry.detectedAt) / (1000 * 60 * 60 * 24));
    const daysLabel = daysSince === 0 ? "today" : `${daysSince} day(s) ago`;
    userPromptParts.push(
      "",
      `**⚠️ Sender suppression note:**`,
      `The current message sender (id:${senderId}) has previously expressed annoyance at the assistant (${suppressedEntry.count} time(s), first detected ${daysLabel}, reason: "${suppressedEntry.reason}"). Exercise extreme caution — only join if the topic is genuinely compelling AND the sender's current tone suggests they've warmed up or are clearly inviting interaction. If in doubt, skip.`,
    );
  }

  userPromptParts.push("", "Should the assistant participate?");
  const userPrompt = userPromptParts.join("\n");

  const result = await callDecisionModel({ cfg, config, systemPrompt, userPrompt });
  if (result.error) {
    logVerbose(
      `[contextual-activation] ${groupKey}: peeking error: ${result.error} (${result.durationMs}ms)`,
    );
    return { shouldProcess: false, error: result.error };
  }

  const parsed = parseDecisionResponse(result.content);

  // Handle negative feedback detection
  if (parsed.negativeFeedback) {
    recordSuppressedUser(groupKey, parsed.negativeFeedback.userId, parsed.negativeFeedback.reason);
  }

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
      messageId: currentMessage.messageId,
      replyToId: currentMessage.replyToId,
      replyToBody: currentMessage.replyToBody,
      replyToSender: currentMessage.replyToSender,
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

// ---------------------------------------------------------------------------
// Mention filter — decide whether to respond when mentioned/replied to
// ---------------------------------------------------------------------------

export async function shouldRespondToMention(params: {
  cfg: OpenClawConfig;
  config: ContextualActivationConfig;
  recentMessages: GroupHistoryMessage[];
  currentMessage: GroupHistoryMessage;
  groupKey: string;
  botName?: string;
}): Promise<ContextualActivationResult> {
  const { cfg, config, recentMessages, currentMessage, groupKey, botName } = params;
  const mentionFilter = config.mentionFilter;
  if (!mentionFilter?.enabled) {
    return { shouldProcess: true };
  }

  // Probabilistic pre-filter
  const rate = mentionFilter.rate ?? 1;
  if (rate <= 0) {
    return { shouldProcess: false };
  }
  if (rate < 1 && Math.random() > rate) {
    return { shouldProcess: true };
  }

  const contextLimit = config.contextMessages ?? DEFAULT_CONTEXT_MESSAGES;
  const allMessages = [...recentMessages, currentMessage];
  const chatContent = formatMessagesForDecision(allMessages, contextLimit, allMessages);
  const botLabel = botName ?? "AI Assistant";

  const basePrompt =
    mentionFilter.prompt ??
    (mentionFilter.promptExtra
      ? `${DEFAULT_MENTION_FILTER_PROMPT}\n\n**Additional rules:**\n${mentionFilter.promptExtra}`
      : DEFAULT_MENTION_FILTER_PROMPT);

  // Prepend identity context (SOUL.md / IDENTITY.md) so the model understands who it is
  const identityContext = loadIdentityContext(cfg);
  const promptWithIdentity = identityContext
    ? `${identityContext}\n\n---\n\n${basePrompt}`
    : basePrompt;
  const systemPrompt = promptWithIdentity.replace(/\{botName\}/g, botLabel);
  const userPrompt = [
    "**Recent group chat messages:**",
    chatContent,
    "",
    "The last message mentions or replies to you. Should you respond?",
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
      `[contextual-activation] ${groupKey}: mention filter error: ${result.error} (${result.durationMs}ms)`,
    );
    // On error, default to responding (fail-open for mentions)
    return { shouldProcess: true };
  }

  const parsed = parseDecisionResponse(result.content);
  const isRespond = parsed.decision === "RESPOND" || parsed.decision === "YES";
  const reason =
    parsed.reason || (isRespond ? "mention warrants response" : "mention filtered out");

  logVerbose(
    `[contextual-activation] ${groupKey}: mention filter ${isRespond ? "RESPOND" : "IGNORE"} (${result.model}, ${result.durationMs}ms) — ${reason}`,
  );
  recordDecision(groupKey, {
    timestamp: Date.now(),
    mode: "engaged",
    decision: isRespond ? "stay" : "skip",
    reason: `[mention-filter] ${reason}`,
    model: result.model,
    durationMs: result.durationMs,
    sender: currentMessage.sender,
    body: currentMessage.body,
  });

  if (isRespond) {
    return { shouldProcess: true, reason };
  }
  return { shouldProcess: false };
}
