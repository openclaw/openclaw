// Control UI chat module implements local prompt quality guidance.

export type PromptQualityIssue = {
  key: "too-short" | "vague-reference" | "missing-outcome" | "missing-context";
  label: string;
};

export type PromptQualityResult = {
  level: "ready" | "review";
  issues: PromptQualityIssue[];
  template: string;
};

const DIRECT_COMMAND_PATTERN = /^\s*\//u;
const BTW_COMMAND_PATTERN = /^\s*\/(?:btw|side)(?::|\s|$)/iu;
const TASK_VERB_PATTERN =
  /\b(add|analy[sz]e|audit|build|check|compare|create|debug|design|draft|edit|explain|fetch|find|fix|implement|inspect|investigate|list|look|make|open|plan|read|refactor|remove|review|run|search|show|summari[sz]e|test|triage|update|work|write)\b/iu;
const SOFT_CHAT_PATTERN =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yep|nope|cool|great|awesome|lol|haha|good morning|good night)[.!?\s]*$/iu;
const VAGUE_REFERENCE_PATTERN =
  /\b(this|that|it|stuff|thing|things|issue|problem|error|bug|prompt|card|flow)\b/iu;
const CONTEXT_MARKER_PATTERN =
  /\b(in|from|for|using|with|without|because|when|where|repo|file|card|issue|pr|url|http|https|path|branch|workboard|reminder|list|screen|image|attached|attachment|above|previous)\b/iu;
const OUTCOME_MARKER_PATTERN =
  /\b(done|verify|test|summary|summari[sz]e|remaining|when done|acceptance|success|should|must|ensure|confirm|report|return|show|include|avoid|keep|preserve|do not|don't)\b/iu;

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0;
}

function appendMissingTemplateLine(lines: string[], label: string, value: string): void {
  if (lines.some((line) => line.toLowerCase().startsWith(label.toLowerCase()))) {
    return;
  }
  lines.push(`${label}: ${value}`);
}

export function buildPromptQualityTemplate(prompt: string): string {
  const trimmed = prompt.trim();
  const lines = trimmed ? [trimmed] : ["Task:"];
  appendMissingTemplateLine(
    lines,
    "Context",
    "where to look, relevant files, links, or constraints",
  );
  appendMissingTemplateLine(lines, "Goal", "what a good result should look like");
  appendMissingTemplateLine(
    lines,
    "When done",
    "summarize changes, checks run, and anything remaining",
  );
  return lines.join("\n\n");
}

export function analyzePromptQuality(
  prompt: string,
  options: { hasAttachments?: boolean } = {},
): PromptQualityResult {
  const trimmed = prompt.trim();
  const words = wordCount(trimmed);
  const issues: PromptQualityIssue[] = [];

  if (
    !trimmed ||
    DIRECT_COMMAND_PATTERN.test(trimmed) ||
    BTW_COMMAND_PATTERN.test(trimmed) ||
    SOFT_CHAT_PATTERN.test(trimmed)
  ) {
    return { level: "ready", issues, template: buildPromptQualityTemplate(trimmed) };
  }

  const hasTaskVerb = TASK_VERB_PATTERN.test(trimmed);
  const hasContext = CONTEXT_MARKER_PATTERN.test(trimmed) || Boolean(options.hasAttachments);
  const hasOutcome = OUTCOME_MARKER_PATTERN.test(trimmed);
  const hasVagueReference = VAGUE_REFERENCE_PATTERN.test(trimmed);
  const looksLikeTaskPrompt = hasTaskVerb || hasVagueReference;

  if (looksLikeTaskPrompt && (words < 5 || (words < 9 && !hasTaskVerb))) {
    issues.push({ key: "too-short", label: "Add the concrete action you want the agent to take." });
  }
  if (hasVagueReference && !hasContext) {
    issues.push({ key: "vague-reference", label: "Name what this refers to or where to find it." });
  }
  if (hasTaskVerb && !hasContext && words < 18) {
    issues.push({ key: "missing-context", label: "Add context, files, links, or constraints." });
  }
  if (hasTaskVerb && !hasOutcome && words < 24) {
    issues.push({
      key: "missing-outcome",
      label: "Add the expected finish line or summary format.",
    });
  }

  return {
    level: issues.length > 0 ? "review" : "ready",
    issues,
    template: buildPromptQualityTemplate(trimmed),
  };
}
