import type { GeneratingSelector } from "../../infra/generating-metadata.js";
import type { ThinkLevel } from "../thinking.js";
import { isBinaryThinkingProvider, listThinkingLevels } from "../thinking.js";

export type AutoSelectorResult = {
  thinkingLevel: ThinkLevel;
  source: "auto-meta" | "auto-fallback";
  selector: GeneratingSelector;
  reasonBucket?: string;
};

const SIMPLE_ACK_RE =
  /^(hi|hello|hey|thanks|thank you|ok|okay|k|yes|no|cool|got it|sounds good|done)\b[!. ]*$/i;

type AutoThinkLevel = Exclude<ThinkLevel, "off">;

function chooseFromComplexity(params: {
  body: string;
  availableThinkingLevels: AutoThinkLevel[];
  provider: string;
}): { level: AutoThinkLevel; bucket: string } {
  const body = params.body.trim();
  const lower = body.toLowerCase();
  const len = body.length;
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const hasResearchSignal =
    /\b(synthesize|research|survey|comprehensive|detailed report|thorough analysis)\b/.test(
      lower,
    ) ||
    len > 1200 ||
    wordCount > 220;

  if (!body || SIMPLE_ACK_RE.test(body) || len < 24) {
    return { level: "minimal", bucket: "trivial" };
  }

  const architectureSignals =
    /\b(architecture|refactor|migration|trade[\s-]?off|design|rfc|risk|compliance|security)\b/.test(
      lower,
    ) ||
    /\b(debug|root cause|incident|failure mode|postmortem)\b/.test(lower) ||
    lines.length >= 8;
  const multiStepSignals =
    /\b(debug|compare|constraints?|edge cases?|failure mode|root cause|plan|strategy)\b/.test(
      lower,
    ) || /(?:\b\d+\.)|(?:- )/.test(body);
  const simpleExplainSignals =
    /\b(explain|summarize|summary|rewrite|rephrase|translate)\b/.test(lower) && len < 220;

  if (hasResearchSignal) {
    return { level: "xhigh", bucket: "research-grade" };
  }

  if (architectureSignals) {
    return { level: "high", bucket: "debug-architecture-tradeoff" };
  }
  if (multiStepSignals || len > 280) {
    return { level: "medium", bucket: "multi-constraint-planning" };
  }
  if (simpleExplainSignals) {
    return { level: "low", bucket: "simple-explanation" };
  }
  if (len < 100 && wordCount <= 20) {
    return { level: "minimal", bucket: "short-transform" };
  }
  return { level: "low", bucket: "default-low" };
}

function clampLevel(params: {
  candidate: AutoThinkLevel;
  availableThinkingLevels: ThinkLevel[];
  provider: string;
}): AutoThinkLevel {
  if (isBinaryThinkingProvider(params.provider)) {
    return "low";
  }
  if (params.candidate === "xhigh" && !params.availableThinkingLevels.includes("xhigh")) {
    return params.availableThinkingLevels.includes("high") ? "high" : "medium";
  }
  if (params.availableThinkingLevels.includes(params.candidate)) {
    return params.candidate;
  }
  if (params.availableThinkingLevels.includes("minimal")) {
    return "minimal";
  }
  if (params.availableThinkingLevels.includes("low")) {
    return "low";
  }
  return "low";
}

export function resolveAutoThink(input: {
  messageBody?: string;
  provider?: string;
  model?: string;
}): AutoThinkLevel {
  try {
    if (typeof input.messageBody !== "string") {
      return "low";
    }
    const availableThinkingLevels = listThinkingLevels(input.provider, input.model);
    const choice = chooseFromComplexity({
      body: input.messageBody ?? "",
      availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
      provider: input.provider ?? "",
    });
    return clampLevel({
      candidate: choice.level,
      availableThinkingLevels,
      provider: input.provider ?? "",
    });
  } catch {
    return "low";
  }
}

export function resolveAutoThinkWithReason(input: {
  messageBody?: string;
  provider?: string;
  model?: string;
}): { level: AutoThinkLevel; bucket: string } {
  try {
    if (typeof input.messageBody !== "string") {
      return { level: "low", bucket: "fallback-malformed-input" };
    }
    const availableThinkingLevels = listThinkingLevels(input.provider, input.model);
    const choice = chooseFromComplexity({
      body: input.messageBody ?? "",
      availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
      provider: input.provider ?? "",
    });
    return {
      level: clampLevel({
        candidate: choice.level,
        availableThinkingLevels,
        provider: input.provider ?? "",
      }),
      bucket: choice.bucket,
    };
  } catch {
    return { level: "low", bucket: "fallback-exception" };
  }
}

export async function resolveAutoThinkingLevel(params: {
  provider: string;
  model: string;
  messageBody: string;
}): Promise<AutoSelectorResult> {
  const resolved = resolveAutoThinkWithReason({
    messageBody: params.messageBody,
    provider: params.provider,
    model: params.model,
  });
  return {
    thinkingLevel: resolved.level,
    source: "auto-meta",
    reasonBucket: resolved.bucket,
    selector: {
      used: false,
      provider: params.provider,
      model: params.model,
    },
  };
}
