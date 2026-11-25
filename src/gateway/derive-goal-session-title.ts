/**
 * Deterministic session-title fallback when LLM labeling is unavailable.
 * Prefers a task-bearing sentence from already-sanitized user text; never
 * requires a model or local runtime.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionTitleSource } from "../sessions/session-title-source.js";

const DERIVED_GOAL_TITLE_MAX_LEN = 60;

/** Leading host wrappers that are not recoverable user intent (Tang-aligned). */
const HOST_ENVELOPE_PREFIXES = [
  "# agents.md instructions for ",
  "<environment_context>",
  "<permissions instructions>",
  "<skills_instructions>",
  "<apps_instructions>",
  "<plugins_instructions>",
  "<recommended_plugins>",
  "<external_openclaw_",
  "openclaw runtime context",
] as const;

const TASK_VERBS = new Set([
  "add",
  "analyze",
  "build",
  "check",
  "compare",
  "create",
  "debug",
  "design",
  "draft",
  "explain",
  "find",
  "fix",
  "give",
  "help",
  "implement",
  "investigate",
  "list",
  "make",
  "plan",
  "prepare",
  "recommend",
  "recover",
  "rename",
  "resume",
  "review",
  "summarize",
  "test",
  "update",
  "write",
]);

function truncateTitle(text: string): string {
  if (text.length <= DERIVED_GOAL_TITLE_MAX_LEN) {
    return text;
  }
  const cut = truncateUtf16Safe(text, DERIVED_GOAL_TITLE_MAX_LEN - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > DERIVED_GOAL_TITLE_MAX_LEN * 0.6) {
    return `${cut.slice(0, lastSpace)}…`;
  }
  return `${cut}…`;
}

function isHostEnvelope(text: string): boolean {
  const folded = text.trimStart().toLowerCase();
  return HOST_ENVELOPE_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

function toSentenceCase(text: string): string {
  if (!text) {
    return text;
  }
  const first = text[0];
  if (!first || first !== first.toLowerCase()) {
    return text;
  }
  return `${first.toUpperCase()}${text.slice(1)}`;
}

function pickGoalSentence(normalized: string): string {
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.replace(/^["'`([{]+/, "").split(/\s+/);
    const lead = words[0]?.toLowerCase();
    if (lead && TASK_VERBS.has(lead)) {
      return sentence.trim();
    }
  }
  return normalized;
}

/**
 * Build a compact topic label from a first user message without calling a model.
 * Returns undefined when no usable user task remains after stripping envelopes.
 */
export function deriveGoalSessionTitle(firstUserMessage?: string | null): string | undefined {
  if (!firstUserMessage) {
    return undefined;
  }
  const stripped = resolveSessionTitleSource(firstUserMessage)?.replace(/\s+/g, " ").trim();
  if (!stripped || isHostEnvelope(stripped)) {
    return undefined;
  }
  const goal = pickGoalSentence(stripped);
  if (!goal) {
    return undefined;
  }
  return truncateTitle(toSentenceCase(goal));
}
