export type OfflineThomasFallbackReason = "auth" | "billing" | "rate_limit" | "unavailable";

type OfflineThomasFallbackTriggerParams = {
  userMessage: string;
  assistantTexts: readonly string[];
};

const FALLBACK_NOTICE_MAX_USER_CHARS = 180;

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
    "I can still have a real conversation in this local fallback. I will be honest when I am guessing, keep things practical, and help you turn the thought into something usable.",
    "Say what you want to unpack next.",
  ].join("\n\n");
}
