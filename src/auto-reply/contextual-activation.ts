import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId, resolveModelRefFromString } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";

export type ContextualActivationConfig = {
  /** Model reference in "provider/model" format (e.g. "openrouter/meta-llama/llama-3.1-8b-instruct:free"). */
  model: string;
  /** Fallback models tried in order if the primary model fails. */
  fallbacks?: string[];
  /** Custom system prompt for the peeking (join) decision. If omitted, a default prompt is used. */
  prompt?: string;
  /** Custom system prompt for the disengage decision. If omitted, a default prompt is used. */
  disengagePrompt?: string;
  /** Maximum recent messages to include in the decision context. Default: 15. */
  contextMessages?: number;
  /** Base probability (0-1) of even calling the decision model when peeking. Default: 1. */
  baseRate?: number;
  /** Fallback timeout (seconds) after which engaged mode auto-expires if no new messages arrive. Default: 300. */
  engagedTimeout?: number;
};

export type GroupHistoryMessage = {
  sender: string;
  body: string;
  timestamp?: number;
};

/** Per-group engagement state, tracked in memory. */
export type EngagementState = {
  mode: "peeking" | "engaged";
  /** Timestamp (ms) when the bot last participated (sent a reply or entered engaged mode). */
  lastActivityAt: number;
};

/** In-memory store for per-group engagement states. Keyed by groupHistoryKey. */
export const engagementStates = new Map<string, EngagementState>();

const DEFAULT_CONTEXT_MESSAGES = 15;
const DEFAULT_ENGAGED_TIMEOUT_S = 300;

const DEFAULT_PEEKING_PROMPT = `You are a group chat participation advisor for an AI assistant.

Given the recent group chat messages below, decide whether the AI assistant should join the conversation.

The assistant's name is: {botName}

Respond YES if:
- Someone is asking a question the assistant could answer
- The topic is relevant to the assistant's capabilities
- Someone is directly or indirectly addressing the assistant
- The conversation would benefit from the assistant's input
- Someone seems to need help

Respond NO if:
- It's casual small talk between humans
- The topic is purely personal between group members
- The conversation is off-topic or irrelevant
- Adding a response would be intrusive or unwanted
- The group is just sharing memes, reactions, or brief acknowledgments

Respond with exactly one word: YES or NO`;

const DEFAULT_DISENGAGE_PROMPT = `You are a group chat participation advisor for an AI assistant that is currently participating in a conversation.

The assistant's name is: {botName}

Given the recent group chat messages below, decide whether the AI assistant should CONTINUE participating or DISENGAGE (go back to silently observing).

Respond CONTINUE if:
- The current topic is still ongoing and the assistant's input is still relevant
- Someone asked a follow-up question or responded to the assistant
- The conversation still benefits from the assistant's presence
- There are unanswered questions the assistant could help with

Respond DISENGAGE if:
- The topic has naturally concluded or moved on
- The conversation has shifted to casual/personal chat between humans
- The assistant has already provided sufficient input and further replies would be excessive
- The group has gone quiet or the energy has died down
- Continuing to respond would feel intrusive or robotic

Respond with exactly one word: CONTINUE or DISENGAGE`;

export type ContextualActivationResult = {
  shouldProcess: boolean;
  engagementChanged?: boolean;
  error?: string;
};

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

function formatMessagesForDecision(messages: GroupHistoryMessage[], limit: number): string {
  const recent = messages.slice(-limit);
  if (recent.length === 0) {
    return "(no recent messages)";
  }
  return recent
    .map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
      const prefix = time ? `[${time}] ` : "";
      return `${prefix}${m.sender}: ${m.body}`;
    })
    .join("\n");
}

async function callSingleModel(params: {
  cfg: OpenClawConfig;
  modelRaw: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ content: string; error?: string }> {
  const resolved = resolveModelRefFromString({
    raw: params.modelRaw,
    defaultProvider: "openrouter",
  });
  if (!resolved) {
    return { content: "", error: `Invalid model ref: ${params.modelRaw}` };
  }
  const { ref } = resolved;

  const apiKey = resolveApiKeyForProvider(params.cfg, ref.provider);
  if (!apiKey) {
    return { content: "", error: `No API key found for provider: ${ref.provider}` };
  }

  const baseUrl = resolveBaseUrl(params.cfg, ref.provider);
  if (!baseUrl) {
    return { content: "", error: `No base URL for provider: ${ref.provider}` };
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
          { role: "user", content: params.userPrompt },
        ],
        max_tokens: 10,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        content: "",
        error: `${params.modelRaw} HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { content: data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: "", error: `${params.modelRaw}: ${message}` };
  }
}

async function callDecisionModel(params: {
  cfg: OpenClawConfig;
  config: ContextualActivationConfig;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ content: string; error?: string }> {
  const models = [params.config.model, ...(params.config.fallbacks ?? [])];
  const errors: string[] = [];

  for (const modelRaw of models) {
    const result = await callSingleModel({
      cfg: params.cfg,
      modelRaw,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
    });
    if (!result.error) {
      return result;
    }
    logVerbose(`[contextual-activation] ${modelRaw} failed: ${result.error}`);
    errors.push(result.error);
  }

  return { content: "", error: `All models failed: ${errors.join("; ")}` };
}

function getEngagement(groupKey: string): EngagementState {
  const existing = engagementStates.get(groupKey);
  if (existing) {
    return existing;
  }
  const state: EngagementState = { mode: "peeking", lastActivityAt: 0 };
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

/** Mark the bot as having just participated — call this after sending a reply. */
export function touchEngagement(groupKey: string) {
  const state = engagementStates.get(groupKey);
  if (state?.mode === "engaged") {
    state.lastActivityAt = Date.now();
  }
}

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
  const baseRate = config.baseRate ?? 1;
  const engagedTimeout = config.engagedTimeout ?? DEFAULT_ENGAGED_TIMEOUT_S;

  const state = getEngagement(groupKey);

  // Check for engaged timeout fallback
  if (checkEngagedTimeout(state, engagedTimeout)) {
    logVerbose(
      `[contextual-activation] ${groupKey}: engaged timeout (${engagedTimeout}s), returning to peeking`,
    );
    state.mode = "peeking";
  }

  const allMessages = [...recentMessages, currentMessage];
  const chatContent = formatMessagesForDecision(allMessages, contextLimit);
  const botLabel = botName ?? "AI Assistant";

  if (state.mode === "engaged") {
    // --- ENGAGED MODE: ask if we should disengage ---
    const systemPrompt = (config.disengagePrompt ?? DEFAULT_DISENGAGE_PROMPT).replace(
      /\{botName\}/g,
      botLabel,
    );
    const userPrompt = `Recent group chat messages:\n\n${chatContent}\n\nShould the assistant continue participating or disengage?`;

    const result = await callDecisionModel({ cfg, config, systemPrompt, userPrompt });
    if (result.error) {
      logVerbose(`[contextual-activation] ${groupKey}: disengage check error: ${result.error}`);
      // On error, stay engaged (fail-open for ongoing conversations)
      return { shouldProcess: true };
    }

    if (result.content.startsWith("DISENGAGE")) {
      logVerbose(`[contextual-activation] ${groupKey}: model decided to disengage`);
      state.mode = "peeking";
      state.lastActivityAt = 0;
      return { shouldProcess: false, engagementChanged: true };
    }

    logVerbose(`[contextual-activation] ${groupKey}: model decided to continue (engaged)`);
    state.lastActivityAt = Date.now();
    return { shouldProcess: true };
  }

  // --- PEEKING MODE ---

  // Fast path: if baseRate is 0, never participate
  if (baseRate <= 0) {
    return { shouldProcess: false };
  }

  // Probabilistic pre-filter: skip calling the model some of the time
  if (baseRate < 1 && Math.random() > baseRate) {
    return { shouldProcess: false };
  }

  const systemPrompt = (config.prompt ?? DEFAULT_PEEKING_PROMPT).replace(/\{botName\}/g, botLabel);
  const userPrompt = `Recent group chat messages:\n\n${chatContent}\n\nShould the assistant participate?`;

  const result = await callDecisionModel({ cfg, config, systemPrompt, userPrompt });
  if (result.error) {
    logVerbose(`[contextual-activation] ${groupKey}: peeking check error: ${result.error}`);
    return { shouldProcess: false, error: result.error };
  }

  if (result.content.startsWith("YES")) {
    logVerbose(`[contextual-activation] ${groupKey}: model decided to join -> engaged`);
    state.mode = "engaged";
    state.lastActivityAt = Date.now();
    return { shouldProcess: true, engagementChanged: true };
  }

  logVerbose(`[contextual-activation] ${groupKey}: model decided not to join (peeking)`);
  return { shouldProcess: false };
}
