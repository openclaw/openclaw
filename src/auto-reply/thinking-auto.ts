import type { ThinkLevel } from "./thinking.js";

export const AUTO_THINK_CONFIDENCE_THRESHOLD = 0.62;

type AutoThinkDecision = {
  think: ThinkLevel;
  confidence: number;
};

const THINK_LEVEL_SET = new Set<ThinkLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function extractJsonCandidate(raw: string): string | undefined {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  return objectMatch?.[0]?.trim();
}

export function parseAutoThinkDecision(raw: string): AutoThinkDecision | undefined {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const thinkRaw =
    typeof (parsed as Record<string, unknown>).think === "string"
      ? (parsed as Record<string, unknown>).think
      : undefined;
  const confidenceRaw = (parsed as Record<string, unknown>).confidence;

  if (!thinkRaw) {
    return undefined;
  }

  const think = thinkRaw.trim().toLowerCase() as ThinkLevel;
  if (!THINK_LEVEL_SET.has(think)) {
    return undefined;
  }

  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
  if (confidence < 0 || confidence > 1) {
    return undefined;
  }

  return { think, confidence };
}

export function buildAutoThinkClassifierPrompt(userText: string): string {
  return [
    "Classify the required thinking level for the user's request.",
    'Return STRICT JSON only with shape: {"think":"off|minimal|low|medium|high|xhigh","confidence":0..1}',
    "",
    "Rubric:",
    "- off: pure acknowledgements/greetings with no task.",
    "- low: quick/simple requests and short factual asks.",
    "- medium: normal multi-step but routine tasks.",
    "- high: complex analysis/debugging/planning with important tradeoffs.",
    "- xhigh: architecture/spec-level design or deep strategic reasoning.",
    "",
    "Guidance:",
    "- Prefer lower levels when uncertain.",
    "- Use xhigh sparingly.",
    "- confidence should reflect certainty (0..1).",
    "",
    "User request:",
    userText,
  ].join("\n");
}
