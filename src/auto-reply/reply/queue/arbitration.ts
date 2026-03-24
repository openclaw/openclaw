import type { QueueMode } from "./types.js";

export type QueueArbitrationRuleResult = QueueMode | "defer";
export type QueueModelArbitrator = (params: {
  body: string;
  configuredMode: QueueMode;
  isActive: boolean;
  isStreaming: boolean;
}) => Promise<QueueMode | undefined> | QueueMode | undefined;

export type QueueArbitrationDecision = {
  ruleResult: QueueArbitrationRuleResult;
  modelResult?: QueueMode;
  modelLatencyMs?: number;
  finalDecision: QueueMode;
};

const INTERRUPT_PREFIXES = [
  "stop",
  "wait",
  "hold on",
  "pause",
  "abort",
  "cancel",
  "interrupt",
  "scratch that",
  "never mind",
  "ignore that",
  "new topic",
  "another question",
  "change of plans",
  "别说了",
  "停",
  "停止",
  "等等",
  "等一下",
  "打住",
  "先停",
  "重新来",
  "不用了",
  "算了",
  "忽略刚才",
  "换个问题",
  "另一个问题",
  "新问题",
];

const STEER_PREFIXES = [
  "actually",
  "rather",
  "i mean",
  "more precisely",
  "to clarify",
  "clarification",
  "continue",
  "also",
  "plus",
  "补充",
  "补充一下",
  "我的意思是",
  "更准确地说",
  "准确点说",
  "纠正一下",
  "继续",
  "还有",
  "另外",
  "对了",
];

const COLLECT_PREFIXES = [
  "and",
  "but",
  "or",
  "also",
  "plus",
  "另外",
  "还有",
  "以及",
  "然后",
  "对了",
];

const QUESTION_HINTS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "can you",
  "could you",
  "would you",
  "请问",
  "为什么",
  "怎么",
  "如何",
  "怎样",
  "能不能",
  "可以",
  "是否",
  "啥",
  "什么",
];

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasPrefix(text: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    if (text === prefix) {
      return true;
    }
    if (!text.startsWith(prefix)) {
      return false;
    }
    const next = text.slice(prefix.length, prefix.length + 1);
    return !next || /[\s,.;:!?，。！？、…]/.test(next);
  });
}

function looksLikeFragment(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length <= 4) {
    return true;
  }
  if (/^[,.;:!?，。！？、…)\]}]+$/.test(text)) {
    return true;
  }
  if (text.length <= 24 && !/[.!?。！？]$/.test(text)) {
    return hasPrefix(text, COLLECT_PREFIXES) && text.length <= 10;
  }
  return false;
}

function looksLikeStandaloneQuestion(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.includes("?") || text.includes("？")) {
    return true;
  }
  return hasPrefix(text, QUESTION_HINTS);
}

function resolveRuleResult(params: {
  configuredMode: QueueMode;
  isActive: boolean;
  isStreaming: boolean;
  hasExplicitMode: boolean;
  hasModelArbitrator: boolean;
  body: string;
}): QueueArbitrationRuleResult {
  const { configuredMode, isActive, isStreaming, hasExplicitMode, hasModelArbitrator } = params;
  if (hasExplicitMode || !isActive) {
    return configuredMode;
  }

  const text = normalize(params.body);
  if (!text) {
    return configuredMode;
  }

  if (hasPrefix(text, INTERRUPT_PREFIXES)) {
    return "interrupt";
  }
  if (isStreaming && hasPrefix(text, STEER_PREFIXES)) {
    return "steer";
  }
  if (looksLikeFragment(text)) {
    return "collect";
  }
  if (looksLikeStandaloneQuestion(text)) {
    return "interrupt";
  }
  if (isStreaming) {
    return hasModelArbitrator ? "defer" : "interrupt";
  }
  return "defer";
}

export async function arbitrateQueueDecision(params: {
  configuredMode: QueueMode;
  isActive: boolean;
  isStreaming: boolean;
  hasExplicitMode: boolean;
  body: string;
  modelArbitrator?: QueueModelArbitrator;
}): Promise<QueueArbitrationDecision> {
  const ruleResult = resolveRuleResult({
    ...params,
    hasModelArbitrator: Boolean(params.modelArbitrator),
  });
  if (ruleResult !== "defer") {
    return { ruleResult, finalDecision: ruleResult };
  }

  let modelResult: QueueMode | undefined;
  let modelLatencyMs: number | undefined;
  if (params.modelArbitrator) {
    const startedAt = Date.now();
    modelResult = await params.modelArbitrator({
      body: params.body,
      configuredMode: params.configuredMode,
      isActive: params.isActive,
      isStreaming: params.isStreaming,
    });
    modelLatencyMs = Date.now() - startedAt;
  }

  return {
    ruleResult,
    modelResult,
    modelLatencyMs,
    finalDecision: modelResult ?? params.configuredMode,
  };
}
