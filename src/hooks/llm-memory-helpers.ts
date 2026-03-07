/**
 * Shared LLM orchestration for memory management hooks.
 *
 * Provides: digest generation, importance classification, concurrency
 * control (mutex + debounce), token boundary guards, session:end dedup
 * filter, and no-LLM fallback functions.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ParsedMessage, SessionTranscriptSummary } from "./transcript-reader.js";

const log = createSubsystemLogger("hooks/llm-memory-helpers");

// -- Token boundary constants ------------------------------------------------

export const MAX_DIGEST_PROMPT_CHARS = 24_000;
export const MAX_IMPORTANCE_PROMPT_CHARS = 16_000;
const MAX_DIGEST_OUTPUT_CHARS = 8192;
const MAX_FALLBACK_OUTPUT_CHARS = 4096;

// -- Types -------------------------------------------------------------------

export type ImportanceCategory = "research" | "project" | "decision" | "reference" | "routine";

export type ImportanceClassification = {
  important: boolean;
  category: ImportanceCategory;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  slug: string;
};

// -- Mutex / Debounce --------------------------------------------------------

const digestLocks = new Map<string, Promise<void>>();

/**
 * Acquire a digest generation lock for a workspace. If a generation is
 * already in-flight for the same workspace, the call returns immediately
 * (debounce). writeFileWithinRoot provides file-level atomicity; this
 * mutex provides operation-level serialization.
 */
export async function withDigestLock(workspaceDir: string, fn: () => Promise<void>): Promise<void> {
  const key = workspaceDir;
  const existing = digestLocks.get(key);
  if (existing) {
    log.debug("Digest generation already in-flight, debouncing", { workspaceDir });
    return;
  }
  const task = fn().finally(() => digestLocks.delete(key));
  digestLocks.set(key, task);
  return task;
}

// -- Session:end dedup filter ------------------------------------------------

const processedSessions = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;
const DEDUP_MAX_ENTRIES = 50;

function pruneProcessedSessions(): void {
  if (processedSessions.size <= DEDUP_MAX_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [id, ts] of processedSessions) {
    if (now - ts > DEDUP_TTL_MS) {
      processedSessions.delete(id);
    }
  }
}

/**
 * Returns true if this session should be processed by memory hooks.
 * Returns false if it was already processed within the dedup TTL window
 * (prevents double-processing when /new triggers both command:new and session:end).
 */
export function shouldProcessSession(sessionId: string): boolean {
  pruneProcessedSessions();
  const lastProcessed = processedSessions.get(sessionId);
  if (lastProcessed !== undefined && Date.now() - lastProcessed < DEDUP_TTL_MS) {
    return false;
  }
  return true;
}

export function markSessionProcessed(sessionId: string): void {
  processedSessions.set(sessionId, Date.now());
  pruneProcessedSessions();
}

/** Visible for testing only. */
export function _clearProcessedSessions(): void {
  processedSessions.clear();
}

// -- Token boundary guard ----------------------------------------------------

/**
 * Flatten transcripts into a prompt string, newest-session-first.
 * Drops oldest sessions when the char budget is exceeded.
 */
export function truncateTranscriptsForPrompt(
  transcripts: Map<string, SessionTranscriptSummary>,
  maxChars: number,
): string {
  // Sort by updatedAt descending
  const sorted = [...transcripts.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);

  const parts: string[] = [];
  let totalChars = 0;

  for (const session of sorted) {
    const sessionText = session.messages.map((m) => `${m.role}: ${m.text}`).join("\n");

    if (totalChars + sessionText.length > maxChars) {
      // Try to fit a truncated version of this session
      const remaining = maxChars - totalChars;
      if (remaining > 200) {
        parts.push(sessionText.slice(0, remaining));
      }
      break;
    }

    parts.push(sessionText);
    totalChars += sessionText.length;
  }

  return parts.join("\n\n---\n\n");
}

// -- LLM call helpers --------------------------------------------------------

async function runOneShotLLM(params: {
  cfg: OpenClawConfig;
  prompt: string;
  purpose: string;
  timeoutMs?: number;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-" + params.purpose + "-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
    const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
    const provider = parsed?.provider ?? DEFAULT_PROVIDER;
    const model = parsed?.model ?? DEFAULT_MODEL;

    const result = await runEmbeddedPiAgent({
      sessionId: `${params.purpose}-${Date.now()}`,
      sessionKey: `temp:${params.purpose}`,
      agentId,
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt: params.prompt,
      provider,
      model,
      timeoutMs: params.timeoutMs ?? 20_000,
      runId: `${params.purpose}-${Date.now()}`,
    });

    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      return text?.trim() || null;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`LLM call failed (${params.purpose}): ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// -- Digest generation -------------------------------------------------------

const DIGEST_PROMPT_TEMPLATE = `You are a concise summarizer. Analyze the following conversation transcripts from the past several days and produce a structured Markdown digest.

Organize by TOPIC (not chronologically). Focus on decisions, action items, and ongoing work threads. Omit greetings and small talk.

Use EXACTLY these sections:

## Topics Discussed
(bullet list of main topics)

## Key Decisions
(bullet list of decisions made)

## Open Items / Action Items
(checkbox list of pending tasks, TODOs, follow-ups)

## Important Context
(bullet list of background information worth remembering)

Transcripts:
`;

/**
 * Generate a structured cross-session digest via LLM.
 * Returns the Markdown body (without freshness header), or null on failure.
 */
export async function generateDigestViaLLM(params: {
  transcripts: Map<string, SessionTranscriptSummary>;
  cfg: OpenClawConfig;
  maxOutputChars?: number;
}): Promise<string | null> {
  const maxOutput = params.maxOutputChars ?? MAX_DIGEST_OUTPUT_CHARS;
  const transcriptText = truncateTranscriptsForPrompt(params.transcripts, MAX_DIGEST_PROMPT_CHARS);

  if (!transcriptText.trim()) {
    return null;
  }

  const prompt = DIGEST_PROMPT_TEMPLATE + transcriptText;

  const result = await runOneShotLLM({
    cfg: params.cfg,
    prompt,
    purpose: "context-digest",
  });

  if (!result) {
    return null;
  }

  // Enforce output cap
  if (result.length > maxOutput) {
    return result.slice(0, maxOutput) + "\n\n... [content truncated for size]";
  }
  return result;
}

/**
 * No-LLM fallback: generate a date-grouped bullet summary.
 */
export function generateDigestFallback(transcripts: Map<string, SessionTranscriptSummary>): string {
  const sorted = [...transcripts.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
  const parts: string[] = ["## Topics Discussed", ""];

  let totalChars = 0;

  for (const session of sorted) {
    if (totalChars >= MAX_FALLBACK_OUTPUT_CHARS) {
      break;
    }

    const date = new Date(session.updatedAt).toISOString().split("T")[0];
    const userMessages = session.messages.filter((m) => m.role === "user");

    if (userMessages.length === 0) {
      continue;
    }

    parts.push(`### ${date}`);
    const shown = userMessages.slice(0, 5);
    for (const msg of shown) {
      const preview = msg.text.length > 120 ? msg.text.slice(0, 120) + "..." : msg.text;
      const oneLine = preview.replace(/\n+/g, " ").trim();
      parts.push(`- ${oneLine}`);
      totalChars += oneLine.length;
    }
    if (userMessages.length > 5) {
      parts.push(`- *(${userMessages.length - 5} more messages)*`);
    }
    parts.push("");
  }

  if (sorted.length === 0) {
    parts.push("No conversations in the recent window.");
    parts.push("");
  }

  parts.push("## Key Decisions", "", "*No LLM analysis available.*", "");
  parts.push("## Open Items / Action Items", "", "*No LLM analysis available.*", "");
  parts.push("## Important Context", "", "*No LLM analysis available.*", "");

  return parts.join("\n");
}

// -- Importance evaluation (multi-dimensional scoring) -----------------------

/**
 * Result of the Stage 1 multi-dimensional importance evaluation.
 * - pass: whether the session should proceed to Stage 2 (LLM or fallback)
 * - signals: human-readable list of triggered probes for logging/debugging
 * - score: raw numeric score for transparency
 * - hintCategory: best-guess category from keyword signals (used by fallback)
 * - matchedKeywords: keywords that fired (used in output file metadata)
 */
export type ImportanceEvaluation = {
  pass: boolean;
  signals: string[];
  score: number;
  hintCategory: ImportanceCategory;
  matchedKeywords: string[];
};

const PASS_THRESHOLD = 4;

// Explicit intent keywords — extremely high precision, single hit = instant pass.
// Kept intentionally small; these should never false-positive.
const EXPLICIT_INTENT_KEYWORDS = [
  "remember",
  "do not forget",
  "dont forget",
  "don't forget",
  "save this",
  "keep this",
  "memorize",
  "note this",
  "record this",
  "记住",
  "保存这",
  "别忘了",
  "记下来",
  "备忘",
];

// Domain keyword rules — contribute score points + hintCategory.
// No longer act as hard thresholds; one hit = +1 point each.
type DomainKeywordRule = {
  category: ImportanceCategory;
  keywords: string[];
};

const DOMAIN_KEYWORD_RULES: DomainKeywordRule[] = [
  {
    category: "reference",
    keywords: ["important", "重要", "记录"],
  },
  {
    category: "research",
    keywords: [
      "experiment",
      "dataset",
      "methodology",
      "hypothesis",
      "conclusion",
      "literature",
      "citation",
      "findings",
      "analysis",
      "研究",
      "实验",
      "数据集",
      "方法论",
      "结论",
      "文献",
      "分析",
    ],
  },
  {
    category: "project",
    keywords: [
      "milestone",
      "progress",
      "next step",
      "todo",
      "deadline",
      "deploy",
      "release",
      "roadmap",
      "sprint",
      "项目",
      "进度",
      "下一步",
      "部署",
      "里程碑",
      "发布",
    ],
  },
  {
    category: "decision",
    keywords: [
      "decision",
      "choose",
      "compare",
      "trade-off",
      "tradeoff",
      "architecture",
      "versus",
      "pros and cons",
      "决策",
      "选择",
      "对比",
      "架构",
      "方案",
      "权衡",
    ],
  },
];

/**
 * Compute the P75 (75th percentile) of a numeric array.
 */
function percentile75(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.75);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Multi-dimensional importance evaluator (Stage 1).
 *
 * Combines structural probes (code density, message depth, collaboration
 * signals) with keyword scoring to produce a holistic importance assessment.
 * Replaces the old keyword-only pre-filter for better recall without
 * sacrificing precision.
 */
export function evaluateSessionImportance(
  messages: ParsedMessage[],
  customKeywords?: string[],
): ImportanceEvaluation {
  let score = 0;
  const signals: string[] = [];
  const matchedKeywords: string[] = [];
  let hintCategory: ImportanceCategory = "routine";

  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const fullText = messages.map((m) => m.text).join("\n");
  const lower = fullText.toLowerCase();

  // --- Probe 1: Explicit intent (instant pass-through) ---
  for (const kw of EXPLICIT_INTENT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      matchedKeywords.push(kw);
      signals.push(`explicit-intent:${kw}`);
      hintCategory = "reference";
      return { pass: true, signals, score: 99, hintCategory, matchedKeywords };
    }
  }

  // --- Probe 2: Code block density ---
  const codeBlockCount = (fullText.match(/```/g) || []).length / 2; // pairs
  if (codeBlockCount >= 3) {
    score += 4;
    signals.push(`code-blocks:${Math.floor(codeBlockCount)}`);
  } else if (codeBlockCount >= 1) {
    score += 2;
    signals.push(`code-blocks:${Math.floor(codeBlockCount)}`);
  }

  // --- Probe 3: User message depth (P75 length) ---
  const userLengths = userMessages.map((m) => m.text.length);
  const p75Length = percentile75(userLengths);
  if (p75Length > 150) {
    score += 3;
    signals.push(`user-msg-depth:p75=${p75Length}`);
  } else if (p75Length > 80) {
    score += 2;
    signals.push(`user-msg-depth:p75=${p75Length}`);
  }

  // --- Probe 4: Collaboration intensity (structured assistant replies) ---
  const structuredReplies = assistantMessages.filter((m) => {
    const hasHeadings = /^#{1,4}\s/m.test(m.text);
    const hasLists = /^[-*]\s/m.test(m.text);
    const hasNumberedLists = /^\d+\.\s/m.test(m.text);
    return m.text.length > 200 && (hasHeadings || hasLists || hasNumberedLists);
  });
  if (structuredReplies.length >= 2) {
    score += 3;
    signals.push(`collab-intensity:${structuredReplies.length}-structured-replies`);
  } else if (structuredReplies.length === 1) {
    score += 1;
    signals.push(`collab-intensity:${structuredReplies.length}-structured-reply`);
  }

  // --- Probe 5: Conversation turns ---
  if (messages.length >= 16) {
    score += 2;
    signals.push(`turns:${messages.length}`);
  } else if (messages.length > 10) {
    score += 1;
    signals.push(`turns:${messages.length}`);
  }

  // --- Probe 6: URL / path presence ---
  if (/https?:\/\/[^\s]{10,}/.test(fullText)) {
    score += 1;
    signals.push("has-urls");
  }

  // --- Probe 7: Domain keyword scoring (additive, not threshold-gated) ---
  const categoryScores = new Map<ImportanceCategory, number>();
  for (const rule of DOMAIN_KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
        score += 1;
        categoryScores.set(rule.category, (categoryScores.get(rule.category) ?? 0) + 1);
      }
    }
  }

  // --- Probe 8: User-configured custom keywords ---
  if (customKeywords && customKeywords.length > 0) {
    for (const kw of customKeywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
        score += 2;
        signals.push(`custom-keyword:${kw}`);
      }
    }
  }

  if (matchedKeywords.length > 0) {
    signals.push(`keywords:${matchedKeywords.join(",")}`);
  }

  // Determine hintCategory from highest-scoring domain
  if (categoryScores.size > 0) {
    let bestCategory: ImportanceCategory = "reference";
    let bestCount = 0;
    for (const [cat, count] of categoryScores) {
      if (count > bestCount) {
        bestCount = count;
        bestCategory = cat;
      }
    }
    hintCategory = bestCategory;
  }

  return {
    pass: score >= PASS_THRESHOLD,
    signals,
    score,
    hintCategory,
    matchedKeywords,
  };
}

/**
 * @deprecated Use evaluateSessionImportance() instead.
 * Kept for backward compatibility with classifyImportanceFallback().
 */
export function classifyByKeywords(text: string): {
  category: ImportanceCategory;
  matchedKeywords: string[];
} {
  // Delegate to the new evaluator by constructing minimal ParsedMessage array
  const messages: ParsedMessage[] = [{ role: "user", text, timestamp: undefined }];
  const result = evaluateSessionImportance(messages);
  return { category: result.hintCategory, matchedKeywords: result.matchedKeywords };
}

const IMPORTANCE_PROMPT_TEMPLATE = `Analyze the following conversation and classify its importance.
Return a JSON object with these fields:
- important: boolean (true if the conversation contains valuable information worth remembering)
- category: one of "research", "project", "decision", "reference"
- summary: 2-3 sentence summary of the key content
- keyPoints: array of 3-5 bullet points capturing the most important information
- actionItems: array of any action items, TODOs, or follow-ups mentioned (empty array if none)
- slug: a 2-4 word hyphenated filename slug describing the topic

Reply with ONLY the JSON object, no markdown fencing.

Conversation:
`;

/**
 * Stage 2: LLM-based importance classification.
 * Only called when keyword pre-filter detects potential importance.
 */
export async function classifyImportanceViaLLM(params: {
  messages: ParsedMessage[];
  cfg: OpenClawConfig;
}): Promise<ImportanceClassification | null> {
  const transcript = params.messages
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n")
    .slice(0, MAX_IMPORTANCE_PROMPT_CHARS);

  const prompt = IMPORTANCE_PROMPT_TEMPLATE + transcript;

  const result = await runOneShotLLM({
    cfg: params.cfg,
    prompt,
    purpose: "session-importance",
  });

  if (!result) {
    return null;
  }

  try {
    // Strip markdown fencing if the model wrapped it
    const cleaned = result
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    const validCategories = ["research", "project", "decision", "reference"];
    const category = validCategories.includes(parsed.category)
      ? (parsed.category as ImportanceCategory)
      : "reference";

    const slug =
      typeof parsed.slug === "string"
        ? parsed.slug
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40)
        : "conversation";

    return {
      important: parsed.important !== false,
      category,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      slug: slug || "conversation",
    };
  } catch (err) {
    log.error("Failed to parse LLM importance classification JSON", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * No-LLM fallback for importance classification.
 *
 * Accepts an optional pre-computed evaluation result from the multi-dimensional
 * evaluator. When provided, uses hintCategory/signals from the evaluation
 * instead of re-running keyword-only classification (which would miss
 * structurally important sessions that have no keyword hits).
 */
export function classifyImportanceFallback(
  messages: ParsedMessage[],
  evaluation?: ImportanceEvaluation,
): ImportanceClassification | null {
  let category: ImportanceCategory;
  let matchedKeywords: string[];

  if (evaluation && evaluation.pass) {
    category = evaluation.hintCategory !== "routine" ? evaluation.hintCategory : "reference";
    matchedKeywords = evaluation.matchedKeywords;
  } else {
    // Legacy path: re-evaluate if no pre-computed result
    const eval2 = evaluateSessionImportance(messages);
    if (!eval2.pass) {
      return null;
    }
    category = eval2.hintCategory !== "routine" ? eval2.hintCategory : "reference";
    matchedKeywords = eval2.matchedKeywords;
  }

  const userMessages = messages.filter((m) => m.role === "user");
  const firstMsg = userMessages[0]?.text ?? "";
  const lastMsg =
    userMessages.length > 1 ? (userMessages[userMessages.length - 1]?.text ?? "") : "";

  const summaryParts = [firstMsg.slice(0, 200)];
  if (lastMsg && lastMsg !== firstMsg) {
    summaryParts.push(lastMsg.slice(0, 200));
  }
  const summary = summaryParts.join(" ... ");

  const slug =
    firstMsg
      .slice(0, 60)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "conversation";

  const signalNotes = evaluation?.signals.length
    ? evaluation.signals.map((s) => `Signal: ${s}`)
    : matchedKeywords.map((kw) => `Keyword: ${kw}`);

  return {
    important: true,
    category,
    summary,
    keyPoints: signalNotes.length > 0 ? signalNotes : ["Structurally important conversation"],
    actionItems: [],
    slug,
  };
}

/**
 * Check if running in a test environment where LLM calls should be skipped.
 */
export function isTestEnvironment(): boolean {
  return (
    process.env.OPENCLAW_TEST_FAST === "1" ||
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test"
  );
}
