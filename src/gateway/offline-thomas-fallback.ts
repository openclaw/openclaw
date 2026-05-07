export type OfflineThomasFallbackReason =
  | "auth"
  | "billing"
  | "rate_limit"
  | "unavailable"
  | "local";

export type OfflineThomasConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

type OfflineThomasFallbackTriggerParams = {
  userMessage: string;
  assistantTexts: readonly string[];
};

const FALLBACK_NOTICE_MAX_USER_CHARS = 180;
const DEFAULT_LOCAL_MODEL_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LOCAL_MODEL = "llama3.2:3b";
const DEFAULT_LOCAL_MODEL_TIMEOUT_MS = 45_000;
const LOCAL_MODEL_HISTORY_MAX_MESSAGES = 8;
const LOCAL_MODEL_HISTORY_MAX_CHARS = 6_000;
const LOCAL_MODEL_REPLY_MAX_CHARS = 2_500;

function normalizeForMatch(value: string): string {
  return value
    .replace(/^[\s!.-]+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function previewUserMessage(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= FALLBACK_NOTICE_MAX_USER_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, FALLBACK_NOTICE_MAX_USER_CHARS - 3).trimEnd()}...`;
}

function readEnv(name: string): string | undefined {
  const env =
    typeof process !== "undefined" && process.env
      ? (process.env as Record<string, string | undefined>)
      : undefined;
  const value = env?.[name]?.trim();
  return value || undefined;
}

function readEnvNumber(name: string, fallback: number): number {
  const value = readEnv(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function resolveReasonFromText(text: string): OfflineThomasFallbackReason | undefined {
  const lower = normalizeForMatch(text);
  if (!lower) {
    return undefined;
  }
  if (
    lower.includes("billing error") ||
    lower.includes("run out of credits") ||
    lower.includes("out of credits") ||
    lower.includes("insufficient credits") ||
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_quota") ||
    lower.includes("payment required") ||
    lower.includes("check your plan and billing")
  ) {
    return "billing";
  }
  if (
    lower.includes("exceeded your current quota") ||
    lower.includes("quota exceeded") ||
    lower.includes("resource has been exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limited") ||
    lower.includes("too many requests") ||
    lower.includes("usage limit")
  ) {
    return "rate_limit";
  }
  if (
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key") ||
    lower.includes("no api key") ||
    lower.includes("no credentials") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "auth";
  }
  if (
    lower.includes("all models failed") ||
    lower.includes("agent failed before reply") ||
    lower.includes("model unavailable") ||
    lower.includes("provider unavailable") ||
    lower.includes("service unavailable")
  ) {
    return "unavailable";
  }
  return undefined;
}

export function resolveOfflineThomasFallbackReason(
  params: OfflineThomasFallbackTriggerParams,
): OfflineThomasFallbackReason | undefined {
  if (params.userMessage.trim().startsWith("/")) {
    return undefined;
  }
  for (const text of params.assistantTexts) {
    const reason = resolveReasonFromText(text);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

export function shouldUseOfflineThomasFallback(
  params: OfflineThomasFallbackTriggerParams,
): boolean {
  return resolveOfflineThomasFallbackReason(params) !== undefined;
}

function reasonLine(reason: OfflineThomasFallbackReason): string {
  switch (reason) {
    case "billing":
      return "I'm in free local Thomas mode because the cloud model account is out of credits.";
    case "auth":
      return "I'm in free local Thomas mode because the cloud model credentials are not working.";
    case "rate_limit":
      return "I'm in free local Thomas mode because the cloud model is rate-limited right now.";
    case "unavailable":
      return "I'm in free local Thomas mode because the cloud model is unavailable right now.";
    case "local":
      return "I'm in local Thomas mode.";
  }
}

function asksForExternalWork(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "browse",
    "search the web",
    "look up",
    "download",
    "update my project",
    "change files",
    "edit files",
    "run command",
    "install",
    "send email",
    "calendar",
  ].some((needle) => lower.includes(needle));
}

function asksCapabilities(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("what can you do") ||
    lower.includes("who are you") ||
    lower.includes("help me") ||
    lower.includes("how can you help")
  );
}

function asksGreeting(message: string): boolean {
  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening)\b/i.test(message.trim());
}

function asksPlanning(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("plan") ||
    lower.includes("overwhelmed") ||
    lower.includes("stuck") ||
    lower.includes("where do i start") ||
    lower.includes("what should i do")
  );
}

export function buildOfflineThomasFallbackReply(params: {
  userMessage: string;
  reason: OfflineThomasFallbackReason;
}): string {
  const userPreview = previewUserMessage(params.userMessage);
  const opener = reasonLine(params.reason);
  const subjectLine = userPreview ? `You said: "${userPreview}"` : "I'm here.";

  if (asksForExternalWork(params.userMessage)) {
    return [
      `${opener} Small brain, big enthusiasm.`,
      subjectLine,
      "I can't browse, can't call cloud tools, and can't change files from this local fallback, but I can still help you think through the next move. Tell me the goal and the constraints, and I will turn it into a clean checklist, draft, or decision path.",
    ].join("\n\n");
  }

  if (asksCapabilities(params.userMessage)) {
    return [
      `${opener} Small brain, big enthusiasm.`,
      subjectLine,
      "What I can still do right now: talk, plan, draft, organize messy thoughts, break problems into next steps, and keep you company with Thomas-flavored honesty. What I cannot do in this mode: use live tools, browse, inspect files, or make model-grade claims.",
      "Give me a topic, a worry, or a half-formed idea and I will help shape it.",
    ].join("\n\n");
  }

  if (asksGreeting(params.userMessage)) {
    return [
      `${opener} Small brain, big enthusiasm.`,
      "Hey. Thomas is still here, just running on the emergency local batteries. We can talk, sketch plans, draft messages, or untangle whatever is in your head.",
    ].join("\n\n");
  }

  if (asksPlanning(params.userMessage)) {
    return [
      `${opener} Small brain, big enthusiasm.`,
      subjectLine,
      "My local take: first make the next step smaller, then make it visible, then do one pass without trying to perfect it.",
      "A useful starting shape: 1. name the outcome, 2. list the blockers, 3. pick the smallest action that creates momentum.",
    ].join("\n\n");
  }

  return [
    `${opener} Small brain, big enthusiasm.`,
    subjectLine,
    params.reason === "local"
      ? "I can have a real conversation here. I will be honest when I am guessing, keep things practical, and help you turn the thought into something usable."
      : "I can still have a real conversation in this local fallback. I will be honest when I am guessing, keep things practical, and help you turn the thought into something usable.",
    "Say what you want to unpack next.",
  ].join("\n\n");
}

function normalizeHistory(
  history: readonly OfflineThomasConversationMessage[] | undefined,
): OfflineThomasConversationMessage[] {
  if (!history?.length) {
    return [];
  }
  const normalized: OfflineThomasConversationMessage[] = [];
  let remainingChars = LOCAL_MODEL_HISTORY_MAX_CHARS;
  for (const item of history.slice(-LOCAL_MODEL_HISTORY_MAX_MESSAGES).reverse()) {
    const text = item.text.replace(/\s+/gu, " ").trim();
    if (!text || remainingChars <= 0) {
      continue;
    }
    const capped = text.length > remainingChars ? text.slice(0, remainingChars).trimEnd() : text;
    remainingChars -= capped.length;
    normalized.push({ role: item.role, text: capped });
  }
  return normalized.reverse();
}

function localModelSystemPrompt(reason: OfflineThomasFallbackReason): string {
  return [
    "You are Thomas, OpenClaw's local conversation assistant.",
    reason === "local"
      ? "You are the primary no-key Talk Mode conversation engine."
      : "You are running locally because the normal cloud model or realtime account is unavailable.",
    `Current local mode reason: ${reason}.`,
    "Keep Thomas's personality: useful, personal, lightly funny, proactive, and honest.",
    "Answer the user's actual message directly. Do not give a canned outage notice unless it matters.",
    "You cannot browse, call cloud tools, inspect files, send messages, or change the project from this local mode.",
    "If the user asks for external actions, be honest about that limit and still help them plan, draft, decide, or think.",
    "Match the user's language when practical. If they speak Dutch, answer in Dutch.",
    "Keep replies conversational and compact enough for spoken Talk Mode.",
  ].join("\n");
}

function sanitizeLocalModelReply(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let text = value
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/\s+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!text) {
    return undefined;
  }
  if (text.length > LOCAL_MODEL_REPLY_MAX_CHARS) {
    text = `${text.slice(0, LOCAL_MODEL_REPLY_MAX_CHARS - 3).trimEnd()}...`;
  }
  return text;
}

async function fetchLocalModelReply(params: {
  userMessage: string;
  reason: OfflineThomasFallbackReason;
  history?: readonly OfflineThomasConversationMessage[];
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<string | undefined> {
  const messages = [
    { role: "system", content: localModelSystemPrompt(params.reason) },
    ...normalizeHistory(params.history).map((message) => ({
      role: message.role,
      content: message.text,
    })),
    { role: "user", content: params.userMessage },
  ];
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout =
    controller && params.timeoutMs > 0
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  try {
    const response = await params.fetchImpl(`${trimTrailingSlash(params.baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        keep_alive: "10m",
        options: {
          temperature: 0.7,
          num_ctx: 4096,
          num_predict: 320,
        },
        messages,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as {
      message?: { content?: unknown };
      response?: unknown;
    };
    return sanitizeLocalModelReply(data.message?.content ?? data.response);
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function buildOfflineThomasConversationalFallbackReply(params: {
  userMessage: string;
  reason: OfflineThomasFallbackReason;
  history?: readonly OfflineThomasConversationMessage[];
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  disableLocalModel?: boolean;
}): Promise<string> {
  const staticReply = buildOfflineThomasFallbackReply({
    userMessage: params.userMessage,
    reason: params.reason,
  });
  const disabled =
    params.disableLocalModel === true ||
    isTruthyEnv(readEnv("OPENCLAW_OFFLINE_THOMAS_DISABLE_MODEL")?.toLowerCase());
  const fetchImpl = params.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (disabled || !fetchImpl) {
    return staticReply;
  }
  const reply = await fetchLocalModelReply({
    userMessage: params.userMessage,
    reason: params.reason,
    history: params.history,
    baseUrl:
      params.baseUrl ?? readEnv("OPENCLAW_OFFLINE_THOMAS_BASE_URL") ?? DEFAULT_LOCAL_MODEL_BASE_URL,
    model: params.model ?? readEnv("OPENCLAW_OFFLINE_THOMAS_MODEL") ?? DEFAULT_LOCAL_MODEL,
    timeoutMs:
      params.timeoutMs ??
      readEnvNumber("OPENCLAW_OFFLINE_THOMAS_TIMEOUT_MS", DEFAULT_LOCAL_MODEL_TIMEOUT_MS),
    fetchImpl,
  });
  return reply ?? staticReply;
}
