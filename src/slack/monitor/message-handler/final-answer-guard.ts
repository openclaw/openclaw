import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { matchesHumanCorrection } from "../../../sre/patterns.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import { findSlackIncidentHeaderLineIndex } from "../incident-format.js";
import {
  hasSlackProgressOnlyPrefix,
  SLACK_SUBSTANTIVE_SIGNAL_RE,
  SLACK_SUMMARY_SECTION_RE,
} from "./progress-patterns.js";

type SlackEitherOrQuestion = {
  leftOption: string;
  rightOption: string;
};

type SlackMarkdownTable = {
  startLineIndex: number;
  endLineIndex: number;
  rows: string[][];
};

type SlackMetric = {
  label: string;
  value: number;
};

type SlackMetricLine = {
  linePrefix: string;
  rowLabel: string;
  metrics: SlackMetric[];
};

export type SlackEvidenceRewrite = {
  kind: "metric_line" | "simple_line" | "summary_total" | "table_cell";
  key: string;
  previous: number;
  next: number;
};

const BOTH_OR_NEITHER_RE = /\b(both|neither)\b/i;
const DEPENDS_RE = /\b(?:it\s+)?depends\b/i;
const DISPROVED_THEORY_RE = /^disproved theory:/im;
const STATUS_LABEL_RE = /^(?:\*Status:\*|_Status:_)/i;
const MARKDOWN_TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// Matches markdown separator rows like `|---------|----:|:-----:|`.
const MARKDOWN_TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const SUMMARY_TOTAL_LINE_RE = /^(.*?)(\d[\d,]*)(\s+total\b.*)$/i;
const NUMERIC_TOKEN_SOURCE = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
// Matches standalone summary labels like `Vaults ≥ $10k: 444 total`.
const SUMMARY_TOTAL_CLEAN_LINE_RE = new RegExp(
  `^(.+?):\\s*(${NUMERIC_TOKEN_SOURCE})\\s+total$`,
  "i",
);
// Matches whole numeric cells like `123`, `1,234`, or `-123.45`.
const NUMERIC_CELL_RE = new RegExp(`^${NUMERIC_TOKEN_SOURCE}$`);
// Matches metric fragments like `444 total` inside `foo: 444 total, 12 listed`.
const NUMERIC_LABEL_SEGMENT_RE = new RegExp(`^(${NUMERIC_TOKEN_SOURCE})(?:\\s+)(.+?)$`, "i");
// Matches simple labeled numeric lines like `Grand total: 444 total`.
const LABELED_NUMERIC_LINE_RE = new RegExp(
  `^(?:[-*]\\s*)?(.+?)(?::|\\s+-\\s+)\\s*(${NUMERIC_TOKEN_SOURCE})(\\b.*)$`,
  "i",
);
const SECTION_LINE_RE = /^[-* ]*---\s*(.*?)\s*---\s*$/;
// 12 KB covers typical incident/PR summaries while letting large evidence blobs
// (logs, traces, pasted transcripts) bypass suppression. Replies at or under
// the cutoff still go through the guard; oversized replies deliberately bypass
// suppression so the runtime favors delivery over a risky false positive. Keep
// the cutoff ahead of the regex-heavy path so giant inputs short-circuit early.
const SLACK_PROGRESS_GUARD_MAX_CHARS = 12_000;
// Bound the number of distinct normalized fact keys per reply-evidence pass.
const SLACK_EVIDENCE_FACT_LIMIT = 256;
// Two values are enough to detect a conflict; extra values add memory only.
const SLACK_EVIDENCE_VALUES_PER_KEY_LIMIT = 2;
// Prevent adversarial evidence labels from bloating the fact-map keys.
const SLACK_EVIDENCE_FACT_KEY_MAX_CHARS = 200;
const SLACK_EITHER_OR_MAX_OPTION_WORDS = 8;
const SLACK_NUMERIC_PARSE_MAX_CHARS = 2_048;
const SLACK_NUMERIC_EPSILON = 1e-9;
const SLACK_SUMMARY_GENERIC_TOKENS = new Set([
  "all",
  "count",
  "counts",
  "grand",
  "total",
  "totals",
  "vault",
  "vaults",
]);
const DEFAULT_DISPROVED_THEORY_LINE =
  "Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatching(value: string): string {
  return normalizeWhitespace(value.toLowerCase().replace(/[^a-z0-9\s]/gi, " "));
}

function normalizeSlackGuardText(value: string): string {
  // Repeat the size guard here in case future callers reach this helper
  // directly instead of going through shouldSuppressSlackProgressReply().
  if (!value || value.length > SLACK_PROGRESS_GUARD_MAX_CHARS) {
    return "";
  }
  return normalizeWhitespace(
    stripSlackMentionsForCommandDetection(
      value.replace(/\p{Dash_Punctuation}/gu, "-").replace(/`/g, ""),
    ),
  );
}

function cleanOption(value: string): string {
  return normalizeWhitespace(value.replace(/^[\s"'`([{<]+|[\s"'`)>}\].,!?:;]+$/g, ""));
}

function isLikelyOption(value: string): boolean {
  if (!value) {
    return false;
  }
  const words = value.split(/\s+/).filter(Boolean);
  return (
    words.length > 0 && words.length <= SLACK_EITHER_OR_MAX_OPTION_WORDS && /[a-z0-9]/i.test(value)
  );
}

function extractEitherOrQuestion(text?: string): SlackEitherOrQuestion | null {
  const source = normalizeWhitespace(stripSlackMentionsForCommandDetection(text ?? ""));
  if (!source || !source.includes("?") || !/\bor\b/i.test(source)) {
    return null;
  }

  const candidate = source
    .split("?")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .toReversed()
    .find((chunk) => /\bor\b/i.test(chunk));
  if (!candidate) {
    return null;
  }

  const match = candidate.match(/(.+?)\s+\bor\b\s+(.+)/i);
  if (!match) {
    return null;
  }

  const leftOption = cleanOption(match[1] ?? "");
  const rightOption = cleanOption(match[2] ?? "");
  if (!isLikelyOption(leftOption) || !isLikelyOption(rightOption)) {
    return null;
  }

  return { leftOption, rightOption };
}

function hasOptionMention(replyText: string, option: string): boolean {
  const normalizedReply = normalizeForMatching(replyText);
  const normalizedOption = normalizeForMatching(option);
  if (!normalizedReply || !normalizedOption) {
    return false;
  }
  return normalizedReply.includes(normalizedOption);
}

function resolveDirectAnswerToken(params: {
  replyText: string;
  question: SlackEitherOrQuestion;
}): string | null {
  const hasLeft = hasOptionMention(params.replyText, params.question.leftOption);
  const hasRight = hasOptionMention(params.replyText, params.question.rightOption);

  if (hasLeft && hasRight) {
    return "both";
  }
  if (hasLeft) {
    return params.question.leftOption;
  }
  if (hasRight) {
    return params.question.rightOption;
  }

  if (BOTH_OR_NEITHER_RE.test(params.replyText)) {
    const value = params.replyText.match(BOTH_OR_NEITHER_RE)?.[1]?.toLowerCase();
    return value === "neither" ? "neither" : "both";
  }
  if (DEPENDS_RE.test(params.replyText)) {
    return "it depends";
  }

  return null;
}

function extractSlackLeadContentLine(replyText: string): string {
  for (const rawLine of replyText.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^<@[^>]*>$/.test(trimmed) || /^\[\[[^\]]+\]\]$/.test(trimmed)) {
      continue;
    }
    return normalizeSlackGuardText(trimmed);
  }
  return "";
}

function hasSlackSubstantiveSignal(replyText: string): boolean {
  return (
    SLACK_SUMMARY_SECTION_RE.test(replyText) ||
    DISPROVED_THEORY_RE.test(replyText) ||
    /^direct\s+answer\s*:/im.test(replyText) ||
    SLACK_SUBSTANTIVE_SIGNAL_RE.test(replyText)
  );
}

/**
 * Returns true when a Slack reply is just progress chatter with no substantive
 * incident/PR/CI signal and should therefore be suppressed in final-only
 * incident thread contexts.
 */
export function shouldSuppressSlackProgressReply(replyText?: string): boolean {
  if (!replyText) {
    return false;
  }
  // Bail out before trim/regex work when the raw input is already oversized.
  if (replyText.length > SLACK_PROGRESS_GUARD_MAX_CHARS) {
    return false;
  }
  const trimmed = replyText.trim();
  if (!trimmed) {
    return false;
  }
  if (hasSlackSubstantiveSignal(trimmed)) {
    return false;
  }
  const leadLine = extractSlackLeadContentLine(trimmed);
  if (!leadLine) {
    return false;
  }
  return hasSlackProgressOnlyPrefix(leadLine);
}

export function applySlackFinalReplyGuards(params: {
  questionText?: string;
  inboundText?: string;
  evidenceTexts?: string[];
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  onEvidenceRewrite?: (rewrite: SlackEvidenceRewrite) => void;
  payload: ReplyPayload;
}): ReplyPayload {
  const directAnswerPayload = enforceSlackDirectEitherOrAnswer({
    questionText: params.questionText,
    payload: params.payload,
  });
  const evidenceConsistentPayload = enforceSlackEvidenceConsistency({
    evidenceTexts: params.evidenceTexts,
    onRewrite: params.onEvidenceRewrite,
    payload: directAnswerPayload,
  });
  const numericSummaryPayload = enforceSlackNumericSummaryConsistency({
    onRewrite: params.onEvidenceRewrite,
    payload: evidenceConsistentPayload,
  });
  const disprovedTheoryPayload = enforceSlackDisprovedTheoryRetraction({
    inboundText: params.inboundText,
    incidentRootOnly: params.incidentRootOnly,
    isThreadReply: params.isThreadReply,
    payload: numericSummaryPayload,
  });
  return enforceSlackNoProgressOnlyReply({
    incidentRootOnly: params.incidentRootOnly,
    isThreadReply: params.isThreadReply,
    payload: disprovedTheoryPayload,
  });
}

export function enforceSlackDirectEitherOrAnswer(params: {
  questionText?: string;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (/^direct\s+answer\s*:/i.test(replyText)) {
    return params.payload;
  }

  const question = extractEitherOrQuestion(params.questionText);
  if (!question) {
    return params.payload;
  }

  const directAnswer = resolveDirectAnswerToken({ replyText, question });
  if (directAnswer) {
    return params.payload;
  }

  return {
    ...params.payload,
    text: `Direct answer: it depends.\n\n${replyText}`,
  };
}

function splitSlackMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function cleanSlackCellText(cell: string): string {
  return cell.replace(/[*_`]/g, "").trim();
}

function normalizeSlackFactKey(...parts: string[]): string {
  return parts
    .map((part) => cleanSlackCellText(part).toLowerCase())
    .join(" ")
    .replace(/>=|≥/g, " gte ")
    .replace(/<=|≤/g, " lte ")
    .replace(/>/g, " gt ")
    .replace(/</g, " lt ")
    .replace(/\$/g, " usd ")
    .replace(/%/g, " pct ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundSlackNumericValue(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(12));
}

function areSlackNumbersEquivalent(left: number, right: number): boolean {
  return (
    Math.abs(roundSlackNumericValue(left) - roundSlackNumericValue(right)) < SLACK_NUMERIC_EPSILON
  );
}

function sumSlackNumbers(values: number[]): number {
  return roundSlackNumericValue(values.reduce((acc, value) => acc + value, 0));
}

function findSlackMarkdownTables(replyText: string | string[]): SlackMarkdownTable[] {
  const lines = Array.isArray(replyText) ? replyText : replyText.split("\n");
  const tables: SlackMarkdownTable[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[lineIndex] ?? "")) {
      lineIndex += 1;
      continue;
    }

    const startLineIndex = lineIndex;
    const tableLines: string[] = [];
    while (lineIndex < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[lineIndex] ?? "")) {
      tableLines.push(lines[lineIndex] ?? "");
      lineIndex += 1;
    }

    if (tableLines.length < 3 || !MARKDOWN_TABLE_SEPARATOR_RE.test(tableLines[1] ?? "")) {
      continue;
    }
    const rows = tableLines.map(splitSlackMarkdownTableRow);
    if ((rows[0]?.length ?? 0) !== (rows[1]?.length ?? 0)) {
      continue;
    }

    tables.push({
      startLineIndex,
      endLineIndex: lineIndex - 1,
      rows,
    });
  }

  return tables;
}

function parseSlackNumericCell(cell: string): number | null {
  const normalizedCell = cleanSlackCellText(cell);
  if (!normalizedCell || normalizedCell.length > SLACK_NUMERIC_PARSE_MAX_CHARS) {
    return null;
  }
  if (!NUMERIC_CELL_RE.test(normalizedCell)) {
    return null;
  }
  const normalized = normalizedCell.replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return roundSlackNumericValue(parsed);
}

function formatSlackNumericCellFromTemplate(template: string, value: number): string {
  const formatted = formatSlackCount(value);
  const trimmed = template.trim();
  if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
    return `**${formatted}**`;
  }
  if (trimmed.startsWith("*") && trimmed.endsWith("*")) {
    return `*${formatted}*`;
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return `\`${formatted}\``;
  }
  return formatted;
}

function renderSlackMarkdownRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function isSlackTotalRowLabel(label: string): boolean {
  const normalized = cleanSlackCellText(label).toLowerCase();
  return normalized === "total" || normalized === "grand total";
}

function isSlackBulletLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function extractSlackMeaningfulFactTokens(value: string): string[] {
  return normalizeSlackFactKey(value)
    .split(" ")
    .filter((token) => token && !SLACK_SUMMARY_GENERIC_TOKENS.has(token));
}

function hasSlackSummaryLabelAlignment(label: string, table: SlackMarkdownTable): boolean {
  if (isSlackTotalRowLabel(label)) {
    return true;
  }

  const labelTokens = extractSlackMeaningfulFactTokens(label);
  const primaryHeaderTokens = extractSlackMeaningfulFactTokens(table.rows[0]?.[1] ?? "");
  if (labelTokens.length === 0 || primaryHeaderTokens.length === 0) {
    return false;
  }

  const primaryHeaderTokenSet = new Set(primaryHeaderTokens);
  return labelTokens.some((token) => primaryHeaderTokenSet.has(token));
}

function parseSlackNumericTokens(text: string): number[] {
  const cleaned = cleanSlackCellText(text);
  if (cleaned.length > SLACK_NUMERIC_PARSE_MAX_CHARS) {
    return [];
  }

  const values: number[] = [];
  let tokenStart = -1;

  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index] ?? "";
    const isTokenChar =
      (char >= "0" && char <= "9") || char === "," || char === "." || char === "-";
    if (isTokenChar) {
      if (tokenStart < 0) {
        tokenStart = index;
      }
      continue;
    }

    if (tokenStart >= 0) {
      const value = parseSlackNumericCell(cleaned.slice(tokenStart, index));
      if (value != null) {
        values.push(value);
      }
      tokenStart = -1;
    }
  }

  if (tokenStart >= 0) {
    const value = parseSlackNumericCell(cleaned.slice(tokenStart));
    if (value != null) {
      values.push(value);
    }
  }

  return values;
}

function extractSlackMetricSuffix(text: string): string {
  return cleanSlackCellText(text)
    .replace(/^[^a-z0-9]+/i, "")
    .trim();
}

function parseSlackMetricSegment(segment: string): SlackMetric | null {
  const match = NUMERIC_LABEL_SEGMENT_RE.exec(cleanSlackCellText(segment));
  if (!match) {
    return null;
  }
  const value = parseSlackNumericCell(match[1] ?? "");
  const label = cleanSlackCellText(match[2] ?? "");
  if (value == null || !label) {
    return null;
  }
  return { label, value };
}

function parseSlackMetricLine(line: string): SlackMetricLine | null {
  if (MARKDOWN_TABLE_ROW_RE.test(line)) {
    return null;
  }

  const trimmed = line.trim();
  if (!trimmed || /^(?:\*\*.*\*\*|\*.*\*|_.*_|`.*`)$/.test(trimmed)) {
    return null;
  }

  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  const linePrefix = line.slice(0, separatorIndex + 1);
  const rowLabel = cleanSlackCellText(linePrefix.replace(/^\s*[-*]\s*/, "").replace(/:\s*$/, ""));
  if (!rowLabel) {
    return null;
  }

  const metrics = line
    .slice(separatorIndex + 1)
    .split(",")
    .map((segment) => parseSlackMetricSegment(segment))
    .filter((metric): metric is SlackMetric => metric != null);
  if (metrics.length === 0) {
    return null;
  }

  return { linePrefix, rowLabel, metrics };
}

/**
 * Parses the bounded evidence text corpus into normalized numeric facts across
 * supported formats: markdown tables, `--- label ---` sections, metric lines,
 * and simple labeled numeric lines. Facts are only trusted later when a key
 * resolves to exactly one unique numeric value.
 */
function buildSlackEvidenceFactMap(evidenceTexts: string[] | undefined): Map<string, Set<number>> {
  const factMap = new Map<string, Set<number>>();
  const addFact = (key: string, value: number) => {
    if (!key || key.length > SLACK_EVIDENCE_FACT_KEY_MAX_CHARS) {
      return;
    }
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      return;
    }
    if (!factMap.has(key) && factMap.size >= SLACK_EVIDENCE_FACT_LIMIT) {
      return;
    }
    const bucket = factMap.get(key) ?? new Set<number>();
    if (bucket.has(value)) {
      return;
    }
    if (bucket.size >= SLACK_EVIDENCE_VALUES_PER_KEY_LIMIT) {
      factMap.set(key, bucket);
      return;
    }
    bucket.add(value);
    factMap.set(key, bucket);
  };

  for (const evidenceText of evidenceTexts ?? []) {
    if (!evidenceText?.trim()) {
      continue;
    }

    const tables = findSlackMarkdownTables(evidenceText);
    for (const table of tables) {
      const headers = table.rows[0] ?? [];
      const dataRows = table.rows.slice(2);
      const nonTotalRows = dataRows.filter((row) => !isSlackTotalRowLabel(row[0] ?? ""));
      const totalRow = dataRows.find((row) => isSlackTotalRowLabel(row[0] ?? ""));

      for (const row of nonTotalRows) {
        const rowLabel = row[0] ?? "";
        for (let colIndex = 1; colIndex < row.length && colIndex < headers.length; colIndex += 1) {
          const value = parseSlackNumericCell(row[colIndex] ?? "");
          if (value == null) {
            continue;
          }
          addFact(normalizeSlackFactKey(rowLabel, headers[colIndex] ?? ""), value);
        }
      }

      if (!totalRow || nonTotalRows.length === 0) {
        continue;
      }

      for (let colIndex = 1; colIndex < headers.length; colIndex += 1) {
        const totalValue = parseSlackNumericCell(totalRow[colIndex] ?? "");
        if (totalValue == null) {
          continue;
        }

        const parsedValues = nonTotalRows.map((row) => parseSlackNumericCell(row[colIndex] ?? ""));
        if (parsedValues.some((value) => value == null)) {
          continue;
        }

        const values = parsedValues.filter((value): value is number => value != null);
        if (!areSlackNumbersEquivalent(sumSlackNumbers(values), totalValue)) {
          continue;
        }
        addFact(normalizeSlackFactKey(totalRow[0] ?? "", headers[colIndex] ?? ""), totalValue);
      }
    }

    const lines = evidenceText.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]?.trim() ?? "";
      if (!line) {
        continue;
      }

      const sectionMatch = SECTION_LINE_RE.exec(line);
      if (sectionMatch) {
        const nextValue = parseSlackNumericCell(lines[lineIndex + 1] ?? "");
        if (nextValue != null) {
          addFact(normalizeSlackFactKey(sectionMatch[1] ?? ""), nextValue);
        }
        continue;
      }

      if (MARKDOWN_TABLE_ROW_RE.test(line)) {
        continue;
      }

      const metricLine = parseSlackMetricLine(line);
      if (metricLine) {
        for (const metric of metricLine.metrics) {
          addFact(normalizeSlackFactKey(metricLine.rowLabel, metric.label), metric.value);
        }
        if (metricLine.metrics.length === 1) {
          addFact(normalizeSlackFactKey(metricLine.rowLabel), metricLine.metrics[0]?.value ?? 0);
        }
        continue;
      }

      const numericTokens = parseSlackNumericTokens(line);
      if (numericTokens.length !== 1) {
        continue;
      }

      const labelMatch = LABELED_NUMERIC_LINE_RE.exec(cleanSlackCellText(line));
      if (!labelMatch) {
        continue;
      }
      const label = labelMatch[1] ?? "";
      const metricSuffix = extractSlackMetricSuffix(labelMatch[3] ?? "");
      addFact(normalizeSlackFactKey(label), numericTokens[0] ?? 0);
      if (metricSuffix) {
        addFact(normalizeSlackFactKey(label, metricSuffix), numericTokens[0] ?? 0);
      }
    }
  }

  return factMap;
}

function resolveUniqueSlackEvidenceValue(
  factMap: Map<string, Set<number>>,
  key: string,
): number | null {
  const values = factMap.get(key);
  if (!values || values.size !== 1) {
    return null;
  }
  const [onlyValue] = values;
  return onlyValue ?? null;
}

function resolveUniqueSlackEvidenceValueFromKeys(
  factMap: Map<string, Set<number>>,
  keys: string[],
): number | null {
  for (const key of keys) {
    if (!key) {
      continue;
    }
    const value = resolveUniqueSlackEvidenceValue(factMap, key);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function rewriteSlackSimpleNumericLine(params: {
  line: string;
  evidenceMap: Map<string, Set<number>>;
  onRewrite?: (rewrite: SlackEvidenceRewrite) => void;
}): string {
  if (MARKDOWN_TABLE_ROW_RE.test(params.line)) {
    return params.line;
  }

  const cleaned = cleanSlackCellText(params.line);
  const numericTokens = parseSlackNumericTokens(cleaned);
  if (numericTokens.length !== 1) {
    return params.line;
  }

  const labelMatch = LABELED_NUMERIC_LINE_RE.exec(cleaned);
  if (!labelMatch) {
    return params.line;
  }

  const metricSuffix = extractSlackMetricSuffix(labelMatch[3] ?? "");
  const key = normalizeSlackFactKey(labelMatch[1] ?? "", metricSuffix);
  const evidenceValue = resolveUniqueSlackEvidenceValueFromKeys(params.evidenceMap, [
    key,
    normalizeSlackFactKey(labelMatch[1] ?? ""),
  ]);
  if (evidenceValue == null || areSlackNumbersEquivalent(evidenceValue, numericTokens[0] ?? 0)) {
    return params.line;
  }

  params.onRewrite?.({
    kind: "simple_line",
    key,
    previous: numericTokens[0] ?? 0,
    next: evidenceValue,
  });
  return params.line.replace(new RegExp(NUMERIC_TOKEN_SOURCE), formatSlackCount(evidenceValue));
}

function rewriteSlackMetricLine(params: {
  line: string;
  evidenceMap: Map<string, Set<number>>;
  onRewrite?: (rewrite: SlackEvidenceRewrite) => void;
}): string {
  const metricLine = parseSlackMetricLine(params.line);
  if (!metricLine) {
    return params.line;
  }

  let didChange = false;
  const nextMetrics = metricLine.metrics.map((metric) => {
    const key = normalizeSlackFactKey(metricLine.rowLabel, metric.label);
    const evidenceValue = resolveUniqueSlackEvidenceValueFromKeys(params.evidenceMap, [
      key,
      metricLine.metrics.length === 1 ? normalizeSlackFactKey(metricLine.rowLabel) : "",
    ]);
    if (evidenceValue == null || areSlackNumbersEquivalent(evidenceValue, metric.value)) {
      return metric;
    }
    didChange = true;
    params.onRewrite?.({
      kind: "metric_line",
      key,
      previous: metric.value,
      next: evidenceValue,
    });
    return { ...metric, value: evidenceValue };
  });
  if (!didChange) {
    return params.line;
  }

  return `${metricLine.linePrefix} ${nextMetrics
    .map((metric) => `${formatSlackCount(metric.value)} ${metric.label}`)
    .join(", ")}`;
}

function rewriteSlackMarkdownTablesFromEvidence(params: {
  lines: string[];
  evidenceMap: Map<string, Set<number>>;
  onRewrite?: (rewrite: SlackEvidenceRewrite) => void;
}): string[] {
  const nextLines = [...params.lines];
  const tables = findSlackMarkdownTables(params.lines);

  for (const table of tables) {
    const headers = table.rows[0] ?? [];
    const mutableRows = table.rows.map((row) => [...row]);

    for (let rowIndex = 2; rowIndex < mutableRows.length; rowIndex += 1) {
      const row = mutableRows[rowIndex] ?? [];
      const rowLabel = row[0] ?? "";
      for (let colIndex = 1; colIndex < row.length && colIndex < headers.length; colIndex += 1) {
        const currentValue = parseSlackNumericCell(row[colIndex] ?? "");
        if (currentValue == null) {
          continue;
        }
        const key = normalizeSlackFactKey(rowLabel, headers[colIndex] ?? "");
        const evidenceValue = resolveUniqueSlackEvidenceValue(params.evidenceMap, key);
        if (evidenceValue == null || areSlackNumbersEquivalent(evidenceValue, currentValue)) {
          continue;
        }
        params.onRewrite?.({
          kind: "table_cell",
          key,
          previous: currentValue,
          next: evidenceValue,
        });
        row[colIndex] = formatSlackNumericCellFromTemplate(row[colIndex] ?? "", evidenceValue);
      }
    }

    const totalRowIndex = mutableRows.findIndex((row, rowIndex) => {
      if (rowIndex < 2) {
        return false;
      }
      return isSlackTotalRowLabel(row[0] ?? "");
    });
    if (totalRowIndex >= 0) {
      const nonTotalRows = mutableRows.filter((row, rowIndex) => {
        if (rowIndex < 2) {
          return false;
        }
        return !isSlackTotalRowLabel(row[0] ?? "");
      });
      const totalRow = mutableRows[totalRowIndex] ?? [];
      for (let colIndex = 1; colIndex < totalRow.length; colIndex += 1) {
        const evidenceValues: number[] = [];
        let allRowsValidated = nonTotalRows.length > 0;
        for (const row of nonTotalRows) {
          const evidenceValue = resolveUniqueSlackEvidenceValue(
            params.evidenceMap,
            normalizeSlackFactKey(row[0] ?? "", headers[colIndex] ?? ""),
          );
          if (evidenceValue == null) {
            allRowsValidated = false;
            break;
          }
          evidenceValues.push(evidenceValue);
        }
        if (!allRowsValidated) {
          continue;
        }
        const summed = sumSlackNumbers(evidenceValues);
        const currentTotal = parseSlackNumericCell(totalRow[colIndex] ?? "");
        if (currentTotal == null || areSlackNumbersEquivalent(currentTotal, summed)) {
          continue;
        }
        params.onRewrite?.({
          kind: "table_cell",
          key: normalizeSlackFactKey(totalRow[0] ?? "", headers[colIndex] ?? ""),
          previous: currentTotal,
          next: summed,
        });
        totalRow[colIndex] = formatSlackNumericCellFromTemplate(totalRow[colIndex] ?? "", summed);
      }
    }

    for (let rowIndex = 0; rowIndex < mutableRows.length; rowIndex += 1) {
      if (rowIndex === 1) {
        continue;
      }
      nextLines[table.startLineIndex + rowIndex] = renderSlackMarkdownRow(
        mutableRows[rowIndex] ?? [],
      );
    }
  }

  return nextLines;
}

export function enforceSlackEvidenceConsistency(params: {
  evidenceTexts?: string[];
  onRewrite?: (rewrite: SlackEvidenceRewrite) => void;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError || (params.evidenceTexts?.length ?? 0) === 0) {
    return params.payload;
  }

  const evidenceMap = buildSlackEvidenceFactMap(params.evidenceTexts);
  if (evidenceMap.size === 0) {
    return params.payload;
  }

  let lines = replyText.split("\n");
  lines = rewriteSlackMarkdownTablesFromEvidence({
    lines,
    evidenceMap,
    onRewrite: params.onRewrite,
  });
  lines = lines.map((line) =>
    rewriteSlackMetricLine({ line, evidenceMap, onRewrite: params.onRewrite }),
  );
  lines = lines.map((line) =>
    rewriteSlackSimpleNumericLine({ line, evidenceMap, onRewrite: params.onRewrite }),
  );

  return {
    ...params.payload,
    text: lines.join("\n"),
  };
}

function findSlackSummaryTotalLine(
  lines: string[],
  table: SlackMarkdownTable,
): { lineIndex: number; total: number } | null {
  const nonTotalRowLabels = new Set(
    table.rows
      .slice(2)
      .map((row) => cleanSlackCellText(row[0] ?? ""))
      .filter((label) => label && !isSlackTotalRowLabel(label))
      .map((label) => normalizeSlackFactKey(label)),
  );

  let lineIndex = table.startLineIndex - 1;
  while (lineIndex >= 0 && !(lines[lineIndex] ?? "").trim()) {
    lineIndex -= 1;
  }

  while (lineIndex >= 0) {
    const rawLine = lines[lineIndex] ?? "";
    if (!rawLine.trim()) {
      break;
    }
    if (!isSlackBulletLine(rawLine) || !parseSlackMetricLine(rawLine)) {
      break;
    }
    lineIndex -= 1;
  }

  while (lineIndex >= 0 && !(lines[lineIndex] ?? "").trim()) {
    lineIndex -= 1;
  }
  if (lineIndex < 0) {
    return null;
  }

  const rawLine = lines[lineIndex] ?? "";
  if (!rawLine.trim() || isSlackBulletLine(rawLine)) {
    return null;
  }

  const cleanedLine = cleanSlackCellText(rawLine.trim());
  const match = SUMMARY_TOTAL_CLEAN_LINE_RE.exec(cleanedLine);
  if (!match) {
    return null;
  }

  const label = cleanSlackCellText(match[1] ?? "");
  if (
    !label ||
    nonTotalRowLabels.has(normalizeSlackFactKey(label)) ||
    !hasSlackSummaryLabelAlignment(label, table)
  ) {
    return null;
  }

  const total = parseSlackNumericCell(match[2] ?? "");
  if (total == null) {
    return null;
  }
  return { lineIndex, total };
}

/**
 * Returns the first table's primary total only when the primary numeric column
 * is fully trustworthy: at least one non-total row exists, every non-total row
 * parses as numeric, and those values sum exactly to the total row.
 */
function findSlackTablePrimaryTotal(table: SlackMarkdownTable): number | null {
  const dataRows = table.rows.slice(2);
  const nonTotalRows = dataRows.filter((row) => {
    return !isSlackTotalRowLabel(row[0] ?? "");
  });
  const totalRow = dataRows.find((row) => {
    return isSlackTotalRowLabel(row[0] ?? "");
  });
  const total = parseSlackNumericCell(totalRow?.[1] ?? "");
  if (total == null) {
    return null;
  }

  if (nonTotalRows.length === 0) {
    return null;
  }

  const nonTotalValues: number[] = [];
  for (const row of nonTotalRows) {
    const value = parseSlackNumericCell(row[1] ?? "");
    if (value == null) {
      return null;
    }
    nonTotalValues.push(value);
  }

  const summed = sumSlackNumbers(nonTotalValues);
  if (!areSlackNumbersEquivalent(summed, total)) {
    return null;
  }

  return roundSlackNumericValue(total);
}

function formatSlackCount(value: number): string {
  // Slack analytics replies already use US-style grouping; keep guard rewrites
  // consistent with the surrounding SRE output instead of locale-dependent.
  const normalized = roundSlackNumericValue(value);
  return Number.isInteger(normalized) ? normalized.toLocaleString("en-US") : String(normalized);
}

function rewriteSlackSummaryTotalLine(line: string, nextTotal: number): string {
  return line.replace(
    SUMMARY_TOTAL_LINE_RE,
    (_match, prefix: string, _total: string, suffix: string) =>
      `${prefix}${formatSlackCount(nextTotal)}${suffix}`,
  );
}

/**
 * Rewrites the nearest standalone summary-total line above the first markdown
 * table when, and only when, that table's primary total column fully validates.
 */
export function enforceSlackNumericSummaryConsistency(params: {
  onRewrite?: (rewrite: SlackEvidenceRewrite) => void;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }

  const lines = replyText.split("\n");
  const tables = findSlackMarkdownTables(lines);
  const firstTable = tables[0];
  if (!firstTable) {
    return params.payload;
  }

  const summaryTotal = findSlackSummaryTotalLine(lines, firstTable);
  if (!summaryTotal) {
    return params.payload;
  }

  const tableTotal = findSlackTablePrimaryTotal(firstTable);
  if (tableTotal == null || areSlackNumbersEquivalent(tableTotal, summaryTotal.total)) {
    return params.payload;
  }

  params.onRewrite?.({
    kind: "summary_total",
    key: "headline_total",
    previous: summaryTotal.total,
    next: tableTotal,
  });
  lines[summaryTotal.lineIndex] = rewriteSlackSummaryTotalLine(
    lines[summaryTotal.lineIndex] ?? "",
    tableTotal,
  );
  return {
    ...params.payload,
    text: lines.join("\n"),
  };
}

export function shouldRequireSlackDisprovedTheory(params: {
  inboundText?: string;
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
}): boolean {
  // Human corrections in incident-root-only threads must force an explicit
  // retraction line so follow-up RCA does not silently build on stale bot
  // theories from earlier in the thread.
  if (!params.incidentRootOnly || !params.isThreadReply) {
    return false;
  }
  const source = normalizeWhitespace(
    stripSlackMentionsForCommandDetection(params.inboundText ?? ""),
  );
  if (!source) {
    return false;
  }
  return matchesHumanCorrection(source);
}

function injectSlackDisprovedTheoryLine(replyText: string): string {
  if (DISPROVED_THEORY_RE.test(replyText)) {
    return replyText.trim();
  }
  const lines = replyText.trim().split("\n");
  const incidentIndex = findSlackIncidentHeaderLineIndex(replyText);
  if (lines.length === 0 || incidentIndex < 0) {
    return replyText.trim();
  }
  const statusIndex = lines.findIndex(
    (line, index) => index > incidentIndex && STATUS_LABEL_RE.test(line.trim()),
  );
  const insertAt = statusIndex >= 0 ? statusIndex + 1 : incidentIndex + 1;
  const boundedInsertAt = Math.min(Math.max(insertAt, incidentIndex + 1), lines.length);
  return [
    ...lines.slice(0, boundedInsertAt),
    DEFAULT_DISPROVED_THEORY_LINE,
    ...lines.slice(boundedInsertAt),
  ].join("\n");
}

export function enforceSlackDisprovedTheoryRetraction(params: {
  inboundText?: string;
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (!shouldRequireSlackDisprovedTheory(params)) {
    return params.payload;
  }
  if (DISPROVED_THEORY_RE.test(replyText)) {
    return params.payload;
  }
  if (findSlackIncidentHeaderLineIndex(replyText) < 0) {
    return params.payload;
  }

  return {
    ...params.payload,
    text: injectSlackDisprovedTheoryLine(replyText),
  };
}

export function enforceSlackNoProgressOnlyReply(params: {
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (!params.incidentRootOnly || !params.isThreadReply) {
    return params.payload;
  }
  if (!shouldSuppressSlackProgressReply(replyText)) {
    return params.payload;
  }
  return {
    ...params.payload,
    text: SILENT_REPLY_TOKEN,
  };
}

export { extractEitherOrQuestion };
