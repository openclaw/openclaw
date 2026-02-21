import type { ThinkLevel } from "./thinking.js";

type SelectAdaptiveThinkingLevelParams = {
  text: string;
  supportsXHigh: boolean;
};

const XHIGH_PATTERNS = [
  /\b(system\s+design|architect(?:ure|ural)|design\s+an?\s+architecture|rfc|technical\s+spec|specification)\b/i,
  /\b(migration\s+plan|rollout\s+plan|implementation\s+plan|multi[- ]step\s+plan|roadmap)\b/i,
  /\b(trade[ -]?offs?|pros?\s+and\s+cons|failure\s+modes?|threat\s+model)\b/i,
];

const HIGH_PATTERNS = [
  /\b(strategy|strategic|blueprint|framework)\b/i,
  /\b(plan|approach)\s+(for|to)\b/i,
  /\b(compare|comparison|evaluate|analysis|analyze|assess)\b/i,
  /\b(debug|investigate|root\s+cause|postmortem)\b/i,
];

const MEDIUM_PATTERNS = [
  /\b(explain|summari[sz]e|rewrite|draft|refactor|improve|brainstorm)\b/i,
  /\b(step[- ]by[- ]step|walk\s+me\s+through|help\s+me\s+understand)\b/i,
  /\b(budget|estimate|timeline|checklist|itinerary)\b/i,
];

const LOW_HINT_PATTERNS = [
  /\b(quick\s+answer|tldr|one\s+line|briefly|just\s+tell\s+me)\b/i,
  /^\s*(?:thanks?|thank\s+you|thx|ok|okay|cool|nice)\s*[!.?]*\s*$/i,
  /^\s*(?:hi|hello|hey|yo|sup)\s*[!.?]*\s*$/i,
];

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function selectAdaptiveThinkingLevel(
  params: SelectAdaptiveThinkingLevelParams,
): ThinkLevel | undefined {
  const text = params.text.trim();
  if (!text) {
    return undefined;
  }

  if (matchesAnyPattern(text, XHIGH_PATTERNS)) {
    return params.supportsXHigh ? "xhigh" : "high";
  }

  if (matchesAnyPattern(text, HIGH_PATTERNS)) {
    return "high";
  }

  if (matchesAnyPattern(text, LOW_HINT_PATTERNS)) {
    return "low";
  }

  if (matchesAnyPattern(text, MEDIUM_PATTERNS)) {
    return "medium";
  }

  // Low-confidence intent: defer to normal model/session defaults.
  return undefined;
}
