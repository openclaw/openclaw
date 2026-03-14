/**
 * Meta-router: classifies inbound tasks by type and selects the optimal model.
 *
 * This is the core of the Perplexity Computer-style agent router.
 * Task classification uses keyword heuristics (lightweight, zero-latency).
 * Users can override the router with an explicit model hint.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  BUILTIN_MODEL_CAPABILITIES,
  type ModelCapabilityEntry,
  type ModelTaskType,
  resolveModelForTask,
} from "./model-capabilities.js";

const log = createSubsystemLogger("routing/model-router");

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

type TaskClassification = {
  primary: ModelTaskType;
  secondary?: ModelTaskType;
  requiresVision: boolean;
  confidence: "high" | "medium" | "low";
};

const CODE_PATTERNS = [
  /\b(write|create|implement|debug|fix|refactor|optimize|review)\b.*\b(code|function|class|script|program|api|endpoint|test)\b/i,
  /\b(typescript|javascript|python|rust|go|java|c\+\+|bash|sql|html|css)\b/i,
  /\b(bug|error|exception|stacktrace|compile|deploy|build|docker)\b/i,
  /```[\w]*\n/,
];

const MATH_PATTERNS = [
  /\b(calculate|compute|solve|derive|integrate|differentiate|matrix|equation|formula|probability)\b/i,
  /\b(algebra|calculus|statistics|linear algebra|graph theory|number theory)\b/i,
  /[0-9]+\s*[\+\-\*\/\^]\s*[0-9]+/,
];

const RESEARCH_PATTERNS = [
  /\b(research|find|search|look up|investigate|explore|survey|summarize)\b/i,
  /\b(what is|who is|when did|where is|how does|why does)\b/i,
  /\b(latest|recent|current|news|article|paper|study)\b/i,
];

const CREATIVE_PATTERNS = [
  /\b(write|compose|create|draft|generate)\b.*\b(story|poem|essay|blog|article|script|song|email|marketing)\b/i,
  /\b(creative|imaginative|fictional|narrative|persuasive)\b/i,
];

const VISION_PATTERNS = [
  /\b(image|picture|photo|screenshot|diagram|chart|figure|drawing|logo)\b/i,
  /\b(analyze|describe|caption|ocr|read|extract)\b.*\b(image|picture|photo)\b/i,
];

const DATA_PATTERNS = [
  /\b(analyze|visualize|plot|chart|graph|csv|excel|dataset|dataframe|pandas|sql)\b/i,
  /\b(trend|correlation|regression|clustering|classification|anomaly|forecast)\b/i,
];

const REASONING_PATTERNS = [
  /\b(reason|think|plan|strategy|decision|tradeoff|pros and cons|compare|evaluate|assess)\b/i,
  /\b(complex|nuanced|multi-step|long-term|strategic|ethical)\b/i,
];

function classifyTask(text: string): TaskClassification {
  const lower = text.toLowerCase();
  const scores: Record<ModelTaskType, number> = {
    code: 0,
    math: 0,
    research: 0,
    creative: 0,
    vision: 0,
    video: 0,
    audio: 0,
    "long-context": 0,
    fast: 0,
    reasoning: 0,
    "data-analysis": 0,
    general: 1, // default baseline
  };

  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(lower)) scores.code += 2;
  }
  for (const pattern of MATH_PATTERNS) {
    if (pattern.test(lower)) scores.math += 2;
  }
  for (const pattern of RESEARCH_PATTERNS) {
    if (pattern.test(lower)) scores.research += 2;
  }
  for (const pattern of CREATIVE_PATTERNS) {
    if (pattern.test(lower)) scores.creative += 2;
  }
  for (const pattern of VISION_PATTERNS) {
    if (pattern.test(lower)) scores.vision += 3;
  }
  for (const pattern of DATA_PATTERNS) {
    if (pattern.test(lower)) scores["data-analysis"] += 2;
  }
  for (const pattern of REASONING_PATTERNS) {
    if (pattern.test(lower)) scores.reasoning += 2;
  }

  // Long context heuristic: if text is long or asks about many documents
  if (text.length > 2000) scores["long-context"] += 2;
  if (/\b(document|file|pdf|book|report|whitepaper|transcript)\b/i.test(lower)) {
    scores["long-context"] += 1;
  }

  // Video/audio heuristics
  if (/\b(video|mp4|avi|youtube|clip|footage)\b/i.test(lower)) scores.video += 4;
  if (/\b(audio|mp3|wav|podcast|transcript|speech)\b/i.test(lower)) scores.audio += 4;

  // Find primary and secondary
  const sorted = (Object.entries(scores) as [ModelTaskType, number][]).sort((a, b) => b[1] - a[1]);
  const [primaryEntry, secondaryEntry] = sorted;
  const primary = primaryEntry[0];
  const secondary =
    secondaryEntry && secondaryEntry[1] > 1 && secondaryEntry[0] !== primary
      ? secondaryEntry[0]
      : undefined;

  const confidence =
    primaryEntry[1] >= 4 ? "high" : primaryEntry[1] >= 2 ? "medium" : "low";

  const requiresVision = scores.vision >= 3;

  return { primary, secondary, requiresVision, confidence };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type RouterDecision = {
  provider: string;
  model: string;
  taskType: ModelTaskType;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type RouterOptions = {
  /** Override: skip classification and use this model. */
  modelOverride?: string;
  /**
   * Latency budget hint.
   * fast = prefer low-latency models
   * normal = balanced
   * thorough = prefer high-quality models
   */
  latencyBudget?: "fast" | "normal" | "thorough";
  /** Extra capability entries (user-configured). */
  extraCapabilities?: readonly ModelCapabilityEntry[];
  /** Default provider fallback when no match found. */
  defaultProvider?: string;
  /** Default model fallback when no match found. */
  defaultModel?: string;
};

/**
 * Classifies the task text and returns the best provider/model for it.
 */
export function routeTask(text: string, opts: RouterOptions = {}): RouterDecision {
  // 1. Explicit override — skip classification entirely
  if (opts.modelOverride?.trim()) {
    const raw = opts.modelOverride.trim();
    const slash = raw.indexOf("/");
    const provider = slash >= 0 ? raw.slice(0, slash) : opts.defaultProvider ?? "anthropic";
    const model = slash >= 0 ? raw.slice(slash + 1) : raw;
    log.debug(`Model override applied: ${provider}/${model}`);
    return { provider, model, taskType: "general", confidence: "high", reason: "explicit override" };
  }

  // 2. Classify the task
  const classification = classifyTask(text);
  const capabilities = [...(opts.extraCapabilities ?? []), ...BUILTIN_MODEL_CAPABILITIES];

  // 3. Find best model for primary task type
  const match = resolveModelForTask({
    taskType: classification.primary,
    capabilities,
    latencyBudget: opts.latencyBudget ?? "normal",
    requireVision: classification.requiresVision,
  });

  if (match) {
    log.debug(
      `Routed task (type=${classification.primary}, confidence=${classification.confidence}) → ${match.provider}/${match.model}`,
    );
    return {
      provider: match.provider,
      model: match.model,
      taskType: classification.primary,
      confidence: classification.confidence,
      reason: `classified as "${classification.primary}" with ${classification.confidence} confidence`,
    };
  }

  // 4. Fallback to defaults
  const defaultProvider = opts.defaultProvider ?? "anthropic";
  const defaultModel = opts.defaultModel ?? "claude-sonnet-4-6";
  log.debug(`No model matched for task type "${classification.primary}", using default`);
  return {
    provider: defaultProvider,
    model: defaultModel,
    taskType: classification.primary,
    confidence: "low",
    reason: `no model matched "${classification.primary}", using default`,
  };
}

/**
 * Returns a text summary of what the router would choose, for debugging.
 */
export function describeRoutingDecision(text: string, opts?: RouterOptions): string {
  const decision = routeTask(text, opts);
  return `task_type=${decision.taskType} → ${decision.provider}/${decision.model} (${decision.confidence} confidence): ${decision.reason}`;
}
