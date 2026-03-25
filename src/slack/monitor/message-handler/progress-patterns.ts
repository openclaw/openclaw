// These literal starts come from real progress-only leakage classes seen in
// Slack incident/repo threads. Keep them explicit so prompt/runtime policy can
// block the exact non-substantive phrases operators already complained about.
const SCRIPT_PROGRESS_ONLY_PREFIX_PATTERNS = [
  // These phrases still describe pending work. Completed script/results cases
  // stay out unless they immediately pivot into another progress update.
  "the script\\b\\s+(?:is|was)\\s+(?:running|still running|stuck|failing)\\b.*",
  "the script\\b\\s+will\\b.*",
  "the script\\b\\s+failed\\b.*",
  "the script\\b\\s+needs\\b.*",
  "the script\\b\\s+(?:ran|finished|executed|completed)\\b.*\\b(?:let me|now|next|i(?:['’]ll|\\s+will)|i need)\\b.*",
] as const;

const COMMIT_CREATED_PROGRESS_ONLY_PREFIX_PATTERNS = [
  // Narrow "commit was created" to follow-up chatter so factual, past-tense
  // summaries like "the commit was created yesterday for PR #114" stay allowed.
  "the commit was created\\b\\s*$",
  "the commit was created\\b\\s*[.;,:-]?\\s*(?:let me|now|next|i(?:['’]ll|\\s+will))\\b.*",
] as const;

const GENERIC_PROGRESS_ONLY_PREFIX_PATTERNS = [
  "on it\\b",
  "found it\\b",
  "checking\\b",
  "let me verify\\b",
  "let me check\\b",
  "let me compose\\b",
  "now let me\\b",
  "now i(?:['’]ll|\\s+will)\\b",
  "now i have\\b",
  "i need to\\b",
  ...SCRIPT_PROGRESS_ONLY_PREFIX_PATTERNS,
  "there are stale changes\\b",
  ...COMMIT_CREATED_PROGRESS_ONLY_PREFIX_PATTERNS,
  "pr is created\\. let me\\b",
  "now i see some issues\\b",
  "honest answer:\\s*(?:let me|i need|now|i(?:['’]ll|\\s+will))\\b",
  "everything looks clean\\b",
  "commit is verified(?:\\/signed)?\\b",
  "yes\\s*[-—]\\s*i have the full document\\b",
  "the indentation is\\b",
  "now export it\\b",
  "now fix the\\b",
  "the queryfn reads\\b",
] as const;

const GOOD_PROGRESS_ONLY_PREFIX_PATTERNS = [
  "good(?:\\s|[-—:.])+(?:let me|now let me)\\b",
  "good(?:\\s|[-—:.])+now i(?:['’]ll|\\s+will)\\b",
  "good(?:\\s|[-—:.])+i need to\\b",
] as const;

// Matches labeled Slack incident-summary sections that should always count as
// substantive final content, including both bold and italic variants seen in
// existing SRE prompts.
export const SLACK_SUMMARY_SECTION_RE =
  /^\s*(?:\*Incident:\*|_Incident:_|\*Customer impact:\*|_Customer impact:_|\*Affected services:\*|_Affected services:_|\*Status:\*|_Status:_|\*Evidence:\*|_Evidence:_|\*Likely cause:\*|_Likely cause:_|\*Mitigation:\*|_Mitigation:_|\*Validate:\*|_Validate:_|\*Next:\*|_Next:_|\*Also watching:\*|_Also watching:_|\*Suggested PR:\*|_Suggested PR:_|\*Fix PR:\*|_Fix PR:_|\*Linear:\*|_Linear:_|\*Auto-fix PR:\*|_Auto-fix PR:_|\*Context:\*|_Context:_)/im;

// Matches standalone substantive signals that should defeat progress-prefix
// suppression even in short replies: URLs, PR/Linear references, CI status,
// and concrete build/test job names.
const SLACK_URL_SIGNAL_RE = /https?:\/\/|<https?:\/\//i;
const SLACK_GITHUB_PR_SIGNAL_RE =
  /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|pull\/\d+\b|(?:^|\b)PR\s*[:#]?\s*#?\d+\b|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#\d+/i;
const SLACK_LINEAR_SIGNAL_RE = /linear\.app\//i;
const SLACK_CI_STATUS_SIGNAL_RE =
  /(?:^|\b)CI\b.*\b(?:green|red|failing|failed|broken|passed|pending)\b/i;
const SLACK_BUILD_JOB_SIGNAL_RE = /build\s*\/\s*@|test\s*\/\s*vitest/i;
const SLACK_INCIDENT_STATUS_SIGNAL_RE =
  /\b(?:database|service|services|migration|deploy(?:ment)?|rollback|incident|queue|worker|cache|api|gateway)\b[\s:-]{1,12}(?:recovered|restored|completed|resolved|mitigated|stable|healthy|green)\b|\b(?:recovered|restored|resolved|mitigated)\b\.\s*(?:monitoring|watching)\b/i;

// Compiled once at module load. The final-reply guard only reaches this after
// empty/oversized bailouts, so production use stays one alternation test on
// short final replies before the lead-line prefix check.
export const SLACK_SUBSTANTIVE_SIGNAL_RE = new RegExp(
  [
    SLACK_URL_SIGNAL_RE.source,
    SLACK_GITHUB_PR_SIGNAL_RE.source,
    SLACK_LINEAR_SIGNAL_RE.source,
    SLACK_CI_STATUS_SIGNAL_RE.source,
    SLACK_BUILD_JOB_SIGNAL_RE.source,
    SLACK_INCIDENT_STATUS_SIGNAL_RE.source,
  ].join("|"),
  "i",
);

const GENERIC_PROGRESS_ONLY_PREFIX_RE = new RegExp(
  `^(?:${GENERIC_PROGRESS_ONLY_PREFIX_PATTERNS.join("|")})`,
  "i",
);
const GOOD_PROGRESS_ONLY_PREFIX_RE = new RegExp(
  `^(?:${GOOD_PROGRESS_ONLY_PREFIX_PATTERNS.join("|")})`,
  "i",
);

// Keep the inputs split into explicit pattern lists so broad starters like
// "good" stay narrow enough to avoid catching terse substantive finals such as
// "Good news: deployed."
export function hasSlackProgressOnlyPrefix(text: string): boolean {
  return GENERIC_PROGRESS_ONLY_PREFIX_RE.test(text) || GOOD_PROGRESS_ONLY_PREFIX_RE.test(text);
}
