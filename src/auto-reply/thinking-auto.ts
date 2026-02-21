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
  /\b(plan|strategy|approach|blueprint|framework)\b/i,
  /\b(compare|comparison|evaluate|analysis|analyze|assess)\b/i,
  /\b(debug|investigate|root\s+cause|postmortem)\b/i,
];

const LOW_PATTERNS = [
  /^(hi|hello|hey|yo|sup|thanks|thank\s+you)\b/i,
  /\b(quick\s+answer|tldr|one\s+line|briefly|just\s+tell\s+me)\b/i,
];

export function selectAdaptiveThinkingLevel(
  params: SelectAdaptiveThinkingLevelParams,
): ThinkLevel | undefined {
  const text = params.text.trim();
  if (!text) {
    return undefined;
  }

  for (const pattern of XHIGH_PATTERNS) {
    if (pattern.test(text)) {
      return params.supportsXHigh ? "xhigh" : "high";
    }
  }

  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(text)) {
      return "high";
    }
  }

  for (const pattern of LOW_PATTERNS) {
    if (pattern.test(text)) {
      return "low";
    }
  }

  // Sensible default: medium for normal requests.
  return "medium";
}
