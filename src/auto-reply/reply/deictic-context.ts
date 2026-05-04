function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitContextLines(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function truncateText(value: string, maxChars = 280): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

type ReferenceContext = {
  hasReplyTarget?: boolean;
  hasThreadHistory?: boolean;
  hasThreadStarter?: boolean;
};

const DIRECT_REFERENCE_PATTERNS: RegExp[] = [
  /^(?:this|that|it)(?:\s|$|\?|\.|,|!)/iu,
  /^(?:this|that|it)\s+(?:one|issue|task|change|fix|thing|part)(?:\s|$|\?|\.)/iu,
  /^(?:これ|それ|あれ)(?:$|[\s、。！？?!.]|(?:どう|何|なに|どれ|どっち|について|の件|の話|って|お願い|よろしく|直して|直した|進んでる|進捗|どうなってる))/u,
];

const EXPLICIT_REFERENCE_PATTERNS: RegExp[] = [
  /^(?:この|その|あの)[^\s]{0,12}(?:件|話|実装|修正|PR|issue|タスク|部分|箇所|機能|コード)/iu,
  /^(?:this|that)\s+(?:issue|task|change|fix|implementation|part|section|proposal)/iu,
];

const SHORT_FOLLOWUP_PATTERNS: RegExp[] = [
  /(?:どうなってる|どうする|どう思う|どう見る|お願い|よろしく|確認|直して|進んでる)(?:[\s。！？?!.]*$)/u,
  /^(?:進捗どう|大丈夫|いけそう|その件|この件)(?:[\s。！？?!.]*$)/u,
  /^(?:status\?|how(?:'s| is) it going\??|is it okay\??|does that work\??)$/iu,
];

function hasNearbyContext(context: ReferenceContext | undefined): boolean {
  return Boolean(context?.hasReplyTarget || context?.hasThreadHistory || context?.hasThreadStarter);
}

export function isShortDeicticReference(
  text: string | undefined,
  context?: ReferenceContext,
): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeWhitespace(text);
  if (!normalized || normalized.length > 80) {
    return false;
  }

  const nearby = hasNearbyContext(context);

  if (DIRECT_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (!nearby) {
    return false;
  }

  if (EXPLICIT_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (
    normalized.length <= 24 &&
    SHORT_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }

  return false;
}

export function buildDeicticResolutionNote(params: {
  userText?: string;
  replyToBody?: string;
  threadHistoryBody?: string;
  threadStarterBody?: string;
}): string | undefined {
  if (
    !isShortDeicticReference(params.userText, {
      hasReplyTarget: Boolean(params.replyToBody),
      hasThreadHistory: Boolean(params.threadHistoryBody),
      hasThreadStarter: Boolean(params.threadStarterBody),
    })
  ) {
    return undefined;
  }

  const candidates: Array<{ label: string; text: string }> = [];
  const pushCandidate = (label: string, value: string | undefined) => {
    if (!value) {
      return;
    }
    const lines = splitContextLines(value);
    if (lines.length === 0) {
      return;
    }
    candidates.push({
      label,
      text: truncateText(lines.at(-1) ?? lines[0] ?? ""),
    });
  };

  pushCandidate("replied message", params.replyToBody);
  pushCandidate("thread history", params.threadHistoryBody);
  pushCandidate("thread starter", params.threadStarterBody);

  const lines = [
    "[Deictic reference resolver]",
    "The user message appears to depend on nearby conversation structure. Treat the nearby thread/reply context below as the primary candidate referents before using broader memory.",
    ...candidates.map((candidate, index) => `${index + 1}. ${candidate.label}: ${candidate.text}`),
  ];

  if (candidates.length > 1) {
    lines.push(
      "Multiple nearby candidates exist. If the referent remains ambiguous after considering these, ask a brief clarifying question instead of choosing silently.",
    );
  }

  return lines.join("\n");
}
