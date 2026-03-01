import { createSubsystemLogger } from "../../logging/subsystem.js";

export type ComplexityTier = "simple" | "medium" | "complex";

export type ComplexityRoutingConfig = {
  enabled: boolean;
  tiers: {
    simple: { model?: string; thinking?: string };
    medium: { model?: string; thinking?: string };
    complex: { model?: string; thinking?: string };
  };
};

export type ClassificationResult = {
  tier: ComplexityTier;
  confidence: number; // 0-1
  signals: string[]; // human-readable reasons
};

export const complexityLog = createSubsystemLogger("complexity-routing");

const LOOKUP_KEYWORDS = [
  "what",
  "when",
  "who",
  "where",
  "how much",
  "check",
  "status",
  "show",
  "list",
  "get",
];

const PLANNING_KEYWORDS = [
  "build",
  "implement",
  "design",
  "create",
  "refactor",
  "migrate",
  "architect",
  "deploy",
];

const MULTI_STEP_PHRASES = ["first", "then", "after that", "step 1", "next", "finally"];

const PRIOR_CONTEXT_PHRASES = ["earlier", "we discussed", "continue", "pick up", "resume"];

const TECHNICAL_KEYWORDS = [
  "api",
  "database",
  "schema",
  "endpoint",
  "component",
  "module",
  "class",
  "function",
];

const GREETING_WORDS = new Set([
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "thank",
  "hi",
  "hey",
  "hello",
  "sure",
  "yep",
  "nope",
  "great",
  "got",
  "it",
  "sounds",
  "good",
]);

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function isGreetingOrAck(text: string): boolean {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 6) {
    return false;
  }
  return words.every((w) => GREETING_WORDS.has(w));
}

function startsWithLookupKeyword(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return LOOKUP_KEYWORDS.some((kw) => lower.startsWith(kw));
}

function containsCodeBlocks(text: string): boolean {
  return text.includes("```");
}

function countFilePaths(text: string): number {
  // Match Unix-style paths (/foo/bar), relative paths (./foo), and URLs
  const pathPattern = /(?:\/[\w./-]+|\.{1,2}\/[\w./-]+|[A-Za-z]:\\[\w\\.-]+)/g;
  const urlPattern = /https?:\/\/[^\s]+/g;
  const paths = text.match(pathPattern) ?? [];
  const urls = text.match(urlPattern) ?? [];
  return paths.length + urls.length;
}

function containsPlanningKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return PLANNING_KEYWORDS.some((kw) => {
    const idx = lower.indexOf(kw);
    if (idx === -1) {
      return false;
    }
    // Ensure it's a word boundary
    const before = idx > 0 ? lower[idx - 1] : " ";
    const after = idx + kw.length < lower.length ? lower[idx + kw.length] : " ";
    return /\W/.test(before ?? " ") && /\W/.test(after ?? " ");
  });
}

function containsMultiStepLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  return MULTI_STEP_PHRASES.some((phrase) => lower.includes(phrase));
}

function containsPriorContextRef(text: string): boolean {
  const lower = text.toLowerCase();
  return PRIOR_CONTEXT_PHRASES.some((phrase) => lower.includes(phrase));
}

function countTechnicalKeywords(text: string): number {
  const lower = text.toLowerCase();
  return TECHNICAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

function countQuestionMarks(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

/**
 * Classifies a user message into a complexity tier using rule-based heuristics.
 * No LLM calls or external services are used.
 *
 * Scoring works as follows:
 *   - Negative score → simple signals detected
 *   - Positive score → complex signals detected
 *
 * Thresholds (without biasTowardUpgrade):
 *   score ≤ -2 → simple; score ≥ 3 → complex; else → medium
 *
 * With biasTowardUpgrade=true (default): simple threshold tightens to ≤ -4,
 * bumping borderline messages (score -3 to -2) into medium.
 */
export function classifyComplexity(params: {
  messageText: string;
  toolCount?: number;
  hasAttachments?: boolean;
  biasTowardUpgrade?: boolean;
}): ClassificationResult {
  const { messageText, toolCount = 0, hasAttachments = false } = params;
  const biasTowardUpgrade = params.biasTowardUpgrade !== false;

  const text = messageText.trim();
  const wordCount = countWords(text);
  const questionMarks = countQuestionMarks(text);
  const hasCode = containsCodeBlocks(text);
  const filePathCount = countFilePaths(text);
  const technicalCount = countTechnicalKeywords(text);

  let score = 0;
  const signals: string[] = [];

  // --- SIMPLE signals ---

  // Greeting/ack: strong simple signal — skip lookup/? checks when detected
  const isGreeting = isGreetingOrAck(text);
  if (isGreeting) {
    score -= 3;
    signals.push("greeting or acknowledgment");
  } else {
    // Lookup keyword combined with a single question: strong simple signal
    const isLookup = startsWithLookupKeyword(text);
    const singleQ = questionMarks === 1 && !hasCode;
    if (isLookup && singleQ) {
      score -= 3;
      signals.push("lookup question (single ?)");
    } else if (isLookup) {
      score -= 2;
      signals.push("starts with lookup keyword");
    } else if (singleQ) {
      // Non-lookup single question: mild simple signal
      score -= 1;
      signals.push("single question, no code");
    }
  }

  if (wordCount < 25) {
    score -= 1;
    signals.push(`short message (${wordCount} words)`);
  }

  // Absence of substantive content markers
  if (!hasCode && filePathCount === 0) {
    score -= 1;
    signals.push("no code blocks or file paths");
  }

  // --- COMPLEX signals ---

  if (wordCount > 150) {
    score += 3;
    signals.push(`long message (${wordCount} words)`);
  } else if (wordCount > 80) {
    score += 1;
    signals.push(`medium-length message (${wordCount} words)`);
  }
  if (hasCode) {
    score += 2;
    signals.push("contains code blocks");
  }
  if (filePathCount >= 2) {
    score += 1;
    signals.push(`multiple file paths or URLs (${filePathCount})`);
  }
  // Planning keywords get a strong bonus: these indicate non-trivial intent
  if (containsPlanningKeyword(text)) {
    score += 5;
    signals.push("contains planning keyword");
  }
  // Multi-step language indicates orchestrated, complex work
  if (containsMultiStepLanguage(text)) {
    score += 3;
    signals.push("multi-step language");
  }
  if (containsPriorContextRef(text)) {
    score += 1;
    signals.push("references prior context");
  }
  if (questionMarks >= 2) {
    score += 1;
    signals.push(`multiple questions (${questionMarks})`);
  }
  if (technicalCount > 3) {
    score += 1;
    signals.push(`many technical keywords (${technicalCount})`);
  }
  if (toolCount > 0) {
    score += 1;
    signals.push(`has tools (${toolCount})`);
  }
  if (hasAttachments) {
    score += 1;
    signals.push("has attachments");
  }

  // --- Tier resolution ---
  // biasTowardUpgrade tightens the simple threshold, bumping borderline messages to medium.
  const simpleThreshold = biasTowardUpgrade ? -4 : -2;

  let tier: ComplexityTier;
  let confidence: number;

  if (score <= simpleThreshold) {
    tier = "simple";
    confidence = Math.min(1, Math.abs(score) / 5);
  } else if (score >= 3) {
    tier = "complex";
    confidence = Math.min(1, score / 6);
  } else {
    tier = "medium";
    confidence = 0.5;
  }

  complexityLog.debug("classified", { tier, score, confidence, signals });

  return { tier, confidence, signals };
}
