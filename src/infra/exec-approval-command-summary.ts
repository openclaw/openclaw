export type ExecApprovalCommandPromptSummary = {
  text: string;
  truncated: boolean;
  totalLineCount: number;
  shownLineCount: number;
  hiddenLineCount: number;
  totalCharCount: number;
  hiddenCharCount: number;
};

export const EXEC_APPROVAL_PROMPT_COMMAND_MAX_LINES = 5;
export const EXEC_APPROVAL_PROMPT_COMMAND_MAX_CHARS = 1_200;

const LOGICAL_LINE_BREAK_PATTERN =
  /\\u\{D\}\\u\{A\}|\\u\{A\}|\\u\{D\}|\\u\{2028\}|\\u\{2029\}|\r\n?|\n/gu;

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0 ? value : fallback;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function splitDisplayLines(text: string): string[] {
  const lines: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LOGICAL_LINE_BREAK_PATTERN)) {
    const index = match.index;
    if (typeof index !== "number") {
      continue;
    }
    const marker = match[0];
    const markerText = marker.startsWith("\\u{") ? marker : "";
    lines.push(text.slice(cursor, index) + markerText);
    cursor = index + marker.length;
  }
  lines.push(text.slice(cursor));
  return lines;
}

function buildTruncationMarker(params: {
  totalLineCount: number;
  shownLineCount: number;
  hiddenLineCount: number;
  hiddenCharCount: number;
}): string {
  const details: string[] = [];
  if (params.hiddenLineCount > 0) {
    details.push(`showing first ${params.shownLineCount} of ${params.totalLineCount} lines`);
  }
  if (params.hiddenCharCount > 0) {
    details.push(`${params.hiddenCharCount} ${plural(params.hiddenCharCount, "char")} hidden`);
  }
  return `...[truncated: ${details.join("; ")}]`;
}

export function summarizeExecApprovalCommandForPrompt(
  commandText: string,
  options?: { maxLines?: number; maxChars?: number },
): ExecApprovalCommandPromptSummary {
  const maxLines = positiveLimit(options?.maxLines, EXEC_APPROVAL_PROMPT_COMMAND_MAX_LINES);
  const maxChars = positiveLimit(options?.maxChars, EXEC_APPROVAL_PROMPT_COMMAND_MAX_CHARS);
  const lines = splitDisplayLines(commandText);
  const shownLines = lines.slice(0, maxLines);
  const lineTruncated = lines.length > shownLines.length;
  if (!lineTruncated && commandText.length <= maxChars) {
    return {
      text: commandText,
      truncated: false,
      totalLineCount: lines.length,
      shownLineCount: lines.length,
      hiddenLineCount: 0,
      totalCharCount: commandText.length,
      hiddenCharCount: 0,
    };
  }
  let text = shownLines.join("\n");
  const totalText = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
  }
  const hiddenLineCount = lineTruncated ? lines.length - shownLines.length : 0;
  const hiddenCharCount = Math.max(0, totalText.length - text.length);
  const truncated = hiddenLineCount > 0 || hiddenCharCount > 0;
  if (!truncated) {
    return {
      text,
      truncated: false,
      totalLineCount: lines.length,
      shownLineCount: lines.length,
      hiddenLineCount: 0,
      totalCharCount: totalText.length,
      hiddenCharCount: 0,
    };
  }
  const marker = buildTruncationMarker({
    totalLineCount: lines.length,
    shownLineCount: shownLines.length,
    hiddenLineCount,
    hiddenCharCount,
  });
  return {
    text: text ? `${text}\n${marker}` : marker,
    truncated: true,
    totalLineCount: lines.length,
    shownLineCount: shownLines.length,
    hiddenLineCount,
    totalCharCount: totalText.length,
    hiddenCharCount,
  };
}
