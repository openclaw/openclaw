import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { redactToolPayloadText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";

const MAX_PRESERVED_ACTION_LINES = 12;
const ACTION_REQUIRED_OUTPUT_HEADER = "action-required output preserved:";
const CODE_PROMPT_MASK_CHAR = "\0";
const QUALIFIED_YOUR_CODE_IS_PATTERN =
  /\byour\s+(?:(?:one[- ]time|verification|device|user|authorization|auth|login|otp)\s+)code\s+is\s+(\S+)/i;
const YOUR_CODE_IS_PATTERN = /\byour\s+code\s+is\s+(\S+)/i;
const CODE_PROMPT_PATTERNS = [
  /\b(device|user|verification|authorization|auth|login|one[- ]time|otp)\s+code\b/i,
  /\byour\s+(?:(?:one[- ]time|verification|device)\s+)?code\s*[:=]/i,
  /\b(?:enter|copy)\s+(?:(?:the|this|your)\s+)?(?:(?:following|one[- ]time|verification|device)\s+)?code(?:\s+to\s+continue)?\b/i,
  /\buse\s+(?:(?:this|your)\s+)?(?:(?:one[- ]time|verification|device)\s+)?code\b/i,
];
const ACTION_LINE_PATTERNS = [
  ...CODE_PROMPT_PATTERNS,
  /\bvisit\s+(?:https?:\/\/|www\.)/i,
  /\bopen\s+(?:https?:\/\/|www\.)/i,
  /\bbrowser\s+(?:to|at)\s+(?:https?:\/\/|www\.)/i,
  /\blog(?:\s|-)?in\s+(?:at|to|with)\b/i,
  /\bauth(?:enticate|orize)\s+(?:at|with|using)\b/i,
  /\bhttps?:\/\/[^\s]+\/(?:device|activate|login|oauth|authorize|auth)\b/i,
];
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const CODE_CANDIDATE_PATTERN = /\b(?:[A-Z0-9]{4}(?:[- ][A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})\b/g;
const BARE_SEPARATED_CODE_PATTERN =
  /^(\s*)(?=[A-Z0-9 -]*(?:\d|-))[A-Z0-9]{4}(?:[- ][A-Z0-9]{3,8}){1,4}(\s*)$/;
const BARE_MIXED_CODE_PATTERN =
  /^(\s*)(?=[A-Z0-9]{6,12}\s*$)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}(\s*)$/;
const BARE_NUMERIC_CODE_PATTERN = /^(\s*)\d{6}(\s*)$/;
const BARE_LETTERS_CODE_PATTERN = /^(\s*)[A-Z]{6,12}(\s*)$/;
const BARE_SPACE_SEPARATED_LETTERS_CODE_PATTERN = /^(\s*)[A-Z]{4} [A-Z]{4}(\s*)$/;
const CODE_PROMPT_EXPLANATION_PATTERN = /^\([^\r\n]{1,160}\)$/;
const DIRECT_CODE_VALUE_PREFIX_PATTERN = /\b(?:enter|paste|type)\s+$/i;
const DIRECT_CODE_VALUE_SUFFIX_PATTERN = /^\s*(?:[.,;:!?)]\s*)?$/;
const CONTINUATION_CODE_VALUE_SUFFIX_PATTERN =
  /^\s+(?:(?:in|into|on)\s+(?:the\s+)?(?:browser|app|client)|to\s+continue)\b/i;
const CODE_VALUE_PATTERN = /^(?:[A-Z0-9]{4}(?:-[A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})$/;
const INLINE_CODE_VALUE_PATTERN =
  /^(?=[A-Z0-9-]*(?:\d|-))(?:[A-Z0-9]{4}(?:-[A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})$/;
// Common terminal labels are command diagnostics, not device codes.
const CRON_OUTPUT_STATUS_LINE_PATTERN =
  /^(?:status|result|(?:(?:status|job|result|test|tests|make|task|command|process|run|build|step)(?:\s*:\s*|\s+))?(?:success|succeeded|failed|failure|passed|skipped|complete|completed|cancelled|canceled|finished|pending|queued|running|started|waiting|timeout|timed out|warning|error|aborted|blocked|paused|retrying|stopped|terminated))$/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:access|refresh)[_-]?token|api[_-]?key|token|password|secret)\s*([:=])\s*([^\s;&]+)/gi;

export function isCronCommandActionCriticalLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(
    normalized &&
    (isYourCodeIsPrompt(normalized) ||
      ACTION_LINE_PATTERNS.some((pattern) => pattern.test(normalized))),
  );
}

function isYourCodeIsPrompt(line: string): boolean {
  const qualifiedValue = QUALIFIED_YOUR_CODE_IS_PATTERN.exec(line)?.[1];
  if (qualifiedValue && CODE_VALUE_PATTERN.test(qualifiedValue)) {
    return true;
  }
  const genericValue = YOUR_CODE_IS_PATTERN.exec(line)?.[1];
  return Boolean(genericValue && INLINE_CODE_VALUE_PATTERN.test(genericValue));
}

function isCronCommandCodePromptExplanationLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && CODE_PROMPT_EXPLANATION_PATTERN.test(normalized));
}

function isCronCommandTerminalStatusLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && CRON_OUTPUT_STATUS_LINE_PATTERN.test(normalized));
}

function normalizeLines(lines: string[] | undefined): string[] {
  const result: string[] = [];
  for (const line of lines ?? []) {
    const normalized = normalizeOptionalString(line);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
    if (result.length >= MAX_PRESERVED_ACTION_LINES) {
      break;
    }
  }
  return result;
}

function trimOutput(value: string): string | undefined {
  return normalizeOptionalString(value);
}

function combineOutput(params: { stdout?: string; stderr?: string }): string | undefined {
  const stdout = trimOutput(params.stdout ?? "");
  const stderr = trimOutput(params.stderr ?? "");
  if (stdout && stderr) {
    return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  }
  return stdout ?? stderr;
}

function containsLine(haystack: string | undefined, needle: string): boolean {
  if (!haystack) {
    return false;
  }
  return haystack.split(/\r?\n/).some((line) => line.trim() === needle.trim());
}

export function buildCronCommandSummary(params: {
  stdout: string;
  stderr: string;
  preservedStdoutLines?: string[];
  preservedStderrLines?: string[];
}): string | undefined {
  const tail = combineOutput({ stdout: params.stdout, stderr: params.stderr });
  const preserved = [
    ...normalizeLines(params.preservedStdoutLines),
    ...normalizeLines(params.preservedStderrLines),
  ].filter((line) => !containsLine(tail, line));
  if (preserved.length === 0) {
    return tail;
  }
  const actionBlock = `${ACTION_REQUIRED_OUTPUT_HEADER}\n${preserved.join("\n")}`;
  return tail ? `${actionBlock}\n\n${tail}` : actionBlock;
}

function cronCommandSummaryNeedsExternalRedaction(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }
  return summary
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith(ACTION_REQUIRED_OUTPUT_HEADER) || isCronCommandActionCriticalLine(line),
    );
}

type EmbeddedCodeRedactionMode = "action" | "continuation" | "preserved" | "none";

function maskCodePromptTextForScan(line: string): string {
  let masked = line;
  const codeIsPatterns = [
    { pattern: QUALIFIED_YOUR_CODE_IS_PATTERN, valuePattern: CODE_VALUE_PATTERN },
    { pattern: YOUR_CODE_IS_PATTERN, valuePattern: INLINE_CODE_VALUE_PATTERN },
  ];
  for (const { pattern, valuePattern } of codeIsPatterns) {
    const globalPattern = new RegExp(pattern.source, "gi");
    masked = masked.replace(globalPattern, (match, value: string) => {
      if (!valuePattern.test(value)) {
        return match;
      }
      return `${CODE_PROMPT_MASK_CHAR.repeat(match.length - value.length)}${value}`;
    });
  }
  for (const pattern of CODE_PROMPT_PATTERNS) {
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    masked = masked.replace(globalPattern, (match) => CODE_PROMPT_MASK_CHAR.repeat(match.length));
  }
  return masked;
}

function isCodeCandidateAttachedToPrompt(
  scan: string,
  start: number,
  end: number,
  mode: EmbeddedCodeRedactionMode,
): boolean {
  const prefix = scan.slice(0, start);
  const suffix = scan.slice(end);
  if (
    DIRECT_CODE_VALUE_PREFIX_PATTERN.test(prefix) &&
    (DIRECT_CODE_VALUE_SUFFIX_PATTERN.test(suffix) ||
      (mode === "continuation" && CONTINUATION_CODE_VALUE_SUFFIX_PATTERN.test(suffix)))
  ) {
    return true;
  }
  const promptEnd = scan.lastIndexOf(CODE_PROMPT_MASK_CHAR, start - 1) + 1;
  return (
    promptEnd > 0 &&
    /^[\s:;,=()-]*(?:(?:is|type|use|paste)\s+)?$/i.test(scan.slice(promptEnd, start))
  );
}

function redactEmbeddedCodeCandidates(
  line: string,
  mode: EmbeddedCodeRedactionMode,
  onRedactedCode: (code: string, satisfiesPrompt: boolean) => void,
): string {
  if (mode === "none") {
    return line;
  }
  const scan = maskCodePromptTextForScan(line);
  let cursor = 0;
  let result = "";
  for (const match of scan.matchAll(CODE_CANDIDATE_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    const candidate = line.slice(start, end);
    const attachedToPrompt = isCodeCandidateAttachedToPrompt(scan, start, end, mode);
    const isUnambiguousCodeShape = /[\d -]/.test(candidate);
    const shouldRedact =
      attachedToPrompt ||
      (!isCronCommandTerminalStatusLine(candidate) &&
        (mode === "preserved" || (mode === "action" && isUnambiguousCodeShape)));
    result += line.slice(cursor, start);
    result += shouldRedact ? "[redacted-code]" : candidate;
    if (shouldRedact) {
      onRedactedCode(candidate, attachedToPrompt);
    }
    cursor = end;
  }
  return result + line.slice(cursor);
}

function redactCronCommandSummaryLine(
  line: string,
  embeddedCodeMode: EmbeddedCodeRedactionMode,
  redactBareLetters: boolean,
  onRedactedCode: (code: string, satisfiesPrompt: boolean) => void,
): string {
  let redacted = redactToolPayloadText(line)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}***`;
    })
    .replace(URL_PATTERN, "[redacted-url]");
  redacted = redactEmbeddedCodeCandidates(redacted, embeddedCodeMode, onRedactedCode);
  const bareCode = redacted.trim();
  const redactBareCode = (value: string, pattern: RegExp): string => {
    if (!pattern.test(value)) {
      return value;
    }
    onRedactedCode(bareCode, true);
    return value.replace(pattern, "$1[redacted-code]$2");
  };
  let bareRedacted = redactBareCode(redacted, BARE_SEPARATED_CODE_PATTERN);
  bareRedacted = redactBareCode(bareRedacted, BARE_MIXED_CODE_PATTERN);
  bareRedacted = redactBareCode(bareRedacted, BARE_NUMERIC_CODE_PATTERN);
  if (!redactBareLetters) {
    return bareRedacted;
  }
  bareRedacted = redactBareCode(bareRedacted, BARE_SPACE_SEPARATED_LETTERS_CODE_PATTERN);
  return redactBareCode(bareRedacted, BARE_LETTERS_CODE_PATTERN);
}

function redactKnownCodeOccurrences(summary: string, code: string): string {
  // Once a value is classified as a credential, redact any larger hyphenated token
  // that embeds it too; preserving the wrapper would re-expose the credential.
  const pattern = new RegExp(
    `(^|[^A-Z0-9])(?:[A-Z0-9]{3,12}-)*${escapeRegExp(code)}(?:-[A-Z0-9]{3,12})*(?=$|[^A-Z0-9])`,
    "g",
  );
  return summary.replace(pattern, "$1[redacted-code]");
}

export function redactCronCommandSummaryForExternalDelivery(
  summary: string | undefined,
): string | undefined {
  if (!summary || !cronCommandSummaryNeedsExternalRedaction(summary)) {
    return summary;
  }
  let inPreservedActionBlock = false;
  let actionPromptCarry: "none" | "code-or-explanation" | "code-only" = "none";
  const redactedCodes = new Set<string>();
  let redactedSummary = summary
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part)) {
        return part;
      }
      if (part.trim().length === 0) {
        if (inPreservedActionBlock) {
          // normalizeLines removes blank entries, so this is the block/tail delimiter.
          inPreservedActionBlock = false;
        }
        return part;
      }
      if (part.startsWith(ACTION_REQUIRED_OUTPUT_HEADER)) {
        inPreservedActionBlock = true;
      }
      const isActionLine = isCronCommandActionCriticalLine(part);
      const promptCarry = actionPromptCarry;
      // The first non-status continuation belongs to the preceding action prompt;
      // otherwise an embedded one-time code bypasses the bare-code redaction path.
      const embeddedCodeMode: EmbeddedCodeRedactionMode = inPreservedActionBlock
        ? "preserved"
        : isActionLine
          ? "action"
          : promptCarry !== "none" && !isCronCommandTerminalStatusLine(part)
            ? "continuation"
            : "none";
      let lineSatisfiedPrompt = false;
      const redacted = redactCronCommandSummaryLine(
        part,
        embeddedCodeMode,
        promptCarry !== "none" && !isCronCommandTerminalStatusLine(part),
        (code, satisfiesPrompt) => {
          lineSatisfiedPrompt ||= satisfiesPrompt || (!isActionLine && promptCarry !== "none");
          // Status-shaped values on prompt lines are redacted locally but are too
          // ambiguous to replace throughout otherwise unrelated command output.
          if (
            !isCronCommandTerminalStatusLine(code) &&
            (!isActionLine || inPreservedActionBlock || satisfiesPrompt || /[\d -]/.test(code))
          ) {
            redactedCodes.add(code);
          }
        },
      );
      // Keep the prompt cue only across a short parenthetical explanation;
      // arbitrary output must not turn a later status word into a code.
      if (lineSatisfiedPrompt) {
        actionPromptCarry = "none";
      } else if (isActionLine) {
        actionPromptCarry = "code-or-explanation";
      } else if (
        promptCarry === "code-or-explanation" &&
        isCronCommandCodePromptExplanationLine(part)
      ) {
        actionPromptCarry = "code-only";
      } else {
        actionPromptCarry = "none";
      }
      return redacted;
    })
    .join("");
  // A code already classified in an action context stays secret if output repeats it later.
  for (const code of [...redactedCodes].toSorted((left, right) => right.length - left.length)) {
    redactedSummary = redactKnownCodeOccurrences(redactedSummary, code);
  }
  return redactedSummary;
}
