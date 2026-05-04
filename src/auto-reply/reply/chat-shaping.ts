function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const STRUCTURED_OUTPUT_PATTERNS: RegExp[] = [
  /\b(json|yaml|xml|csv|sql)\b/iu,
  /\btable\b/iu,
  /\b(step by step|numbered list|bullet points?|summary|report|recap)\b/iu,
  /表形式/u,
  /箇条書き/u,
  /手順/u,
  /一覧/u,
  /json/u,
];

const TECHNICAL_DENSE_PATTERNS: RegExp[] = [
  /\b(stack trace|exception|traceback|compile error|build log|diff|patch)\b/iu,
  /```/u,
  /エラーログ/u,
  /スタックトレース/u,
  /差分/u,
];

const CONVERSATIONAL_SIGNAL_PATTERNS: RegExp[] = [
  /[?？!！]$/u,
  /^(?:これ|それ|あれ|この件|その件|大丈夫|どう|お願い|よろしく)/u,
  /^(?:this|that|it|can you|could you|please|how|is it|ok|okay|got it|sounds good|go ahead|thanks)\b/iu,
];

const ADMIN_STATUS_PATTERNS: RegExp[] = [
  /\b(status|summary|recap|report)\b/iu,
  /状況/u,
  /要約/u,
  /報告/u,
  /まとめ/u,
];

export function shouldApplyChatShaping(params: {
  userText?: string;
  replyToBody?: string;
  threadHistoryBody?: string;
  threadStarterBody?: string;
  isGroupChat?: boolean;
}): boolean {
  const userText = normalizeWhitespace(params.userText ?? "");
  if (!userText) {
    return false;
  }

  if (userText.length > 1200) {
    return false;
  }

  if (STRUCTURED_OUTPUT_PATTERNS.some((pattern) => pattern.test(userText))) {
    return false;
  }

  if (TECHNICAL_DENSE_PATTERNS.some((pattern) => pattern.test(userText))) {
    return false;
  }

  if (ADMIN_STATUS_PATTERNS.some((pattern) => pattern.test(userText))) {
    return false;
  }

  if (params.isGroupChat && !params.replyToBody && !params.threadHistoryBody) {
    return false;
  }

  if (CONVERSATIONAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(userText))) {
    return true;
  }

  const hasNearbyContext = Boolean(
    params.replyToBody || params.threadHistoryBody || params.threadStarterBody,
  );
  if (!hasNearbyContext) {
    return false;
  }

  return userText.length <= 80;
}

export function buildChatShapingNote(params: {
  userText?: string;
  replyToBody?: string;
  threadHistoryBody?: string;
  threadStarterBody?: string;
  isGroupChat?: boolean;
}): string | undefined {
  if (!shouldApplyChatShaping(params)) {
    return undefined;
  }

  return [
    "[Chat shaping guidance]",
    "This appears to be a conversational reply, not a formal structured output request.",
    "Preserve the assistant's existing persona and voice signals from the active system/persona instructions, especially stable expression defaults defined in files such as SOUL.md and IDENTITY.md when present.",
    "Treat those persona defaults as durable normal-chat behavior, not optional decoration.",
    "Do not flatten away persona-specific reaction words, pacing, opener style, or low-risk expressive markers merely for polish.",
    "When the persona definition includes preferred expressive signals such as emoji, naturally use them in normal chat replies when they fit the context instead of suppressing them by default.",
    "Prefer persona-consistent response-shaped openings in conversational exchanges, including short acknowledgements and progress updates.",
    "When natural for the exchange, respond before explaining.",
    "Use bullets or headings only if they materially improve clarity or execution.",
    "Keep expression context-appropriate and avoid flattening into generic assistant wording.",
    "If giving an in-progress update during active work, keep it brief, meaningful, bounded under the user's existing intent, and still persona-consistent.",
    "If the user explicitly requests structured output or the situation is safety-critical, clarity-first formatting can override these expression defaults.",
  ].join("\n");
}
