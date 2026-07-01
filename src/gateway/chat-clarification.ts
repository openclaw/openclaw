// Gateway chat clarification gate keeps underspecified prompts from starting runs.

export type ChatClarificationIssueKey =
  | "too_short"
  | "vague_reference"
  | "missing_context"
  | "missing_outcome"
  | "risky_action";

export type ChatClarificationIssue = {
  key: ChatClarificationIssueKey;
  label: string;
};

export type ChatClarificationRequest = {
  question: string;
  issues: ChatClarificationIssue[];
  suggestions: string[];
};

export type ChatClarificationDecision =
  | { action: "execute" }
  | { action: "clarify"; clarification: ChatClarificationRequest };

export type ChatClarificationInput = {
  message: string;
  hasAttachments?: boolean;
  hasPriorSessionContext?: boolean;
  bypass?: boolean;
  isSystemOrigin?: boolean;
  suppressCommandInterpretation?: boolean;
};

const DIRECT_COMMAND_PATTERN = /^\s*\//u;
const SOFT_CHAT_PATTERN =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yep|nope|cool|great|awesome|lol|haha|good morning|good night)[.!?\s]*$/iu;
const CONTEXTUAL_APPROVAL_PATTERN =
  /^\s*(perfect|exactly|yes|yeah|yep|ok|okay|sounds good|go ahead|do that|please do|ship it|please implement|implement it)\b/iu;
const TASK_VERB_PATTERN =
  /\b(add|analy[sz]e|apply|audit|build|change|check|compare|create|debug|delete|deploy|design|draft|edit|explain|fetch|find|fix|implement|inspect|install|investigate|list|look|make|merge|open|plan|read|refactor|remove|reset|review|run|search|send|show|summari[sz]e|test|triage|update|work|write)\b/iu;
const VAGUE_REFERENCE_PATTERN =
  /\b(this|that|it|stuff|thing|things|issue|problem|error|bug|prompt|card|flow)\b/iu;
const CONTEXT_MARKER_PATTERN =
  /\b(in|from|for|using|with|without|because|when|where|repo|repository|file|card|issue|pr|pull request|url|http|https|path|branch|workboard|reminder|list|screen|image|attached|attachment|above|previous|current|conversation|session)\b/iu;
const OUTCOME_MARKER_PATTERN =
  /\b(done|verify|test|summary|summari[sz]e|remaining|when done|acceptance|success|should|must|ensure|confirm|report|return|show|include|avoid|keep|preserve|do not|don't|leave|remain)\b/iu;
const CONCRETE_POINTER_PATTERN =
  /(?:https?:\/\/|(?:^|\s)(?:\.{1,2}\/|\/)[^\s]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|swift|py|rb|go|rs|java|kt|yml|yaml|toml)\b|#[0-9]+|\b[A-F0-9]{7,}(?:-[A-F0-9]{4,})*\b|\b(?:workboard|reminder|github|issue|pull request|pr|file|path|repo|repository)\b)/iu;
const RISKY_ACTION_PATTERN =
  /\b(delete|wipe|destroy|drop|remove|reset|reboot|restart|disable|archive|merge|deploy|publish|send|email|tweet|purchase|charge|overwrite|force|close|lock|unlock|approve|apply|install)\b/iu;
const CONFIRMATION_PATTERN =
  /\b(confirm|confirmed|approved|safe to|go ahead|please proceed|proceed|yes,? do|do it|you can|allowed|permission)\b/iu;

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0;
}

function issue(keys: ChatClarificationIssueKey[], key: ChatClarificationIssueKey): boolean {
  return keys.includes(key);
}

function buildClarificationQuestion(keys: ChatClarificationIssueKey[]): string {
  if (issue(keys, "risky_action")) {
    return "Before I do anything potentially destructive, what exact target should I change, what should stay untouched, and do you want me to proceed?";
  }
  if (issue(keys, "vague_reference") || issue(keys, "missing_context")) {
    return "What exactly should I work on, where should I look, and what does a good result look like?";
  }
  return "What context or finish line should I use before starting?";
}

function shouldClarify(keys: ChatClarificationIssueKey[]): boolean {
  if (issue(keys, "risky_action")) {
    return true;
  }
  if (
    issue(keys, "too_short") &&
    (issue(keys, "vague_reference") || issue(keys, "missing_context"))
  ) {
    return true;
  }
  return keys.length >= 2 && !issue(keys, "missing_outcome");
}

export function evaluateChatClarification(
  input: ChatClarificationInput,
): ChatClarificationDecision {
  const trimmed = input.message.trim();
  if (
    input.bypass ||
    input.isSystemOrigin ||
    input.suppressCommandInterpretation ||
    !trimmed ||
    DIRECT_COMMAND_PATTERN.test(trimmed) ||
    SOFT_CHAT_PATTERN.test(trimmed)
  ) {
    return { action: "execute" };
  }
  if (input.hasPriorSessionContext && CONTEXTUAL_APPROVAL_PATTERN.test(trimmed)) {
    return { action: "execute" };
  }

  const words = wordCount(trimmed);
  const hasAttachments = input.hasAttachments === true;
  const hasTaskVerb = TASK_VERB_PATTERN.test(trimmed);
  const hasVagueReference = VAGUE_REFERENCE_PATTERN.test(trimmed);
  const hasContext = CONTEXT_MARKER_PATTERN.test(trimmed) || hasAttachments;
  const hasConcretePointer = CONCRETE_POINTER_PATTERN.test(trimmed) || hasAttachments;
  const hasOutcome = OUTCOME_MARKER_PATTERN.test(trimmed);
  const hasRiskyAction = RISKY_ACTION_PATTERN.test(trimmed);
  const hasConfirmation = CONFIRMATION_PATTERN.test(trimmed);
  const keys: ChatClarificationIssueKey[] = [];

  if (hasTaskVerb && words < 5) {
    keys.push("too_short");
  }
  if (hasVagueReference && !hasConcretePointer) {
    keys.push("vague_reference");
  }
  if (hasTaskVerb && !hasContext && words < 18) {
    keys.push("missing_context");
  }
  if (hasTaskVerb && !hasOutcome && (words < 8 || !hasContext || hasVagueReference)) {
    keys.push("missing_outcome");
  }
  if (hasRiskyAction && (!hasConcretePointer || !hasConfirmation)) {
    keys.push("risky_action");
  }

  const uniqueKeys = [...new Set(keys)];
  if (!shouldClarify(uniqueKeys)) {
    return { action: "execute" };
  }

  const labels: Record<ChatClarificationIssueKey, string> = {
    too_short: "Add the concrete action you want the agent to take.",
    vague_reference: "Name what this refers to or where to find it.",
    missing_context: "Add context, files, links, or constraints.",
    missing_outcome: "Add the expected finish line or summary format.",
    risky_action: "Confirm the exact target and boundaries for the risky action.",
  };
  return {
    action: "clarify",
    clarification: {
      question: buildClarificationQuestion(uniqueKeys),
      issues: uniqueKeys.map((key) => ({ key, label: labels[key] })),
      suggestions: [
        "Name the target: repo, file, card, issue, screen, or message.",
        "Add constraints: what to preserve, avoid, or ask before changing.",
        "Define done: checks to run, output to produce, or summary format.",
      ],
    },
  };
}
