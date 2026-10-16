import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import type { SessionsUsageOverview } from "../../../../src/shared/usage-types.js";
import type { CostDailyEntry, UsageSessionEntry } from "./types.ts";

function csvEscape(value: string, neutralizeFormulas = true): string {
  const safeValue =
    neutralizeFormulas && /^[ \t\r\n]*[=+\-@\uFF0B\uFF0D\uFF1D\uFF20]/u.test(value)
      ? `'${value}`
      : value;
  if (/[",\r\n]/.test(safeValue)) {
    return `"${safeValue.replaceAll('"', '""')}"`;
  }
  return safeValue;
}

type CsvValue = string | number | undefined | null;

function toCsvRow(values: CsvValue[]): string {
  return values
    .map((value) => {
      if (value === undefined || value === null) {
        return "";
      }
      return csvEscape(String(value), typeof value === "string");
    })
    .join(",");
}

function buildCsv<Entry>(
  entries: Entry[],
  columns: Record<string, (entry: Entry) => CsvValue>,
): string {
  const readers = Object.values(columns);
  return [
    toCsvRow(Object.keys(columns)),
    ...entries.map((entry) => toCsvRow(readers.map((read) => read(entry)))),
  ].join("\n");
}

function usageCsvValue(
  value: number | undefined,
  report?: CostDailyEntry["usageReport"],
): CsvValue {
  return report?.state === "unavailable" ? undefined : value;
}

const buildSessionsCsv = (sessions: UsageSessionEntry[]): string =>
  buildCsv(sessions, {
    key: (session) => session.key,
    label: (session) => session.label,
    agentId: (session) => session.agentId,
    channel: (session) => session.channel,
    provider: (session) => session.modelProvider ?? session.providerOverride,
    model: (session) => session.model ?? session.modelOverride,
    updatedAt: (session) => timestampMsToIsoString(session.updatedAt),
    durationMs: (session) => session.usage?.durationMs,
    messages: (session) => session.usage?.messageCounts?.total,
    errors: (session) => session.usage?.messageCounts?.errors,
    toolCalls: (session) => session.usage?.messageCounts?.toolCalls,
    inputTokens: (session) => usageCsvValue(session.usage?.input, session.usage?.usageReport),
    outputTokens: (session) => usageCsvValue(session.usage?.output, session.usage?.usageReport),
    cacheReadTokens: (session) =>
      usageCsvValue(session.usage?.cacheRead, session.usage?.usageReport),
    cacheWriteTokens: (session) =>
      usageCsvValue(session.usage?.cacheWrite, session.usage?.usageReport),
    totalTokens: (session) => usageCsvValue(session.usage?.totalTokens, session.usage?.usageReport),
    totalCost: (session) => usageCsvValue(session.usage?.totalCost, session.usage?.usageReport),
  });

const buildDailyCsv = (daily: CostDailyEntry[]): string =>
  buildCsv(daily, {
    date: (day) => day.date,
    inputTokens: (day) => usageCsvValue(day.input, day.usageReport),
    outputTokens: (day) => usageCsvValue(day.output, day.usageReport),
    cacheReadTokens: (day) => usageCsvValue(day.cacheRead, day.usageReport),
    cacheWriteTokens: (day) => usageCsvValue(day.cacheWrite, day.usageReport),
    totalTokens: (day) => usageCsvValue(day.totalTokens, day.usageReport),
    inputCost: (day) => usageCsvValue(day.inputCost, day.usageReport),
    outputCost: (day) => usageCsvValue(day.outputCost, day.usageReport),
    cacheReadCost: (day) => usageCsvValue(day.cacheReadCost, day.usageReport),
    cacheWriteCost: (day) => usageCsvValue(day.cacheWriteCost, day.usageReport),
    totalCost: (day) => usageCsvValue(day.totalCost, day.usageReport),
  });

type QuerySuggestion = {
  label: string;
  value: string;
};

export type UsageFilterOptions = SessionsUsageOverview["filterOptions"];

const buildQuerySuggestions = (query: string, options: UsageFilterOptions): QuerySuggestion[] => {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const tokens = extractQueryTerms(trimmed).map((term) => term.raw);
  const lastQueryWord = tokens.at(-1) ?? "";
  const [rawKey, rawValue] = lastQueryWord.includes(":")
    ? [
        lastQueryWord.slice(0, lastQueryWord.indexOf(":")),
        lastQueryWord.slice(lastQueryWord.indexOf(":") + 1),
      ]
    : ["", ""];

  const key = normalizeLowercaseStringOrEmpty(rawKey);
  const value = normalizeLowercaseStringOrEmpty(rawValue);

  if (!key) {
    return [
      "agent:",
      "channel:",
      "provider:",
      "model:",
      "tool:",
      "has:errors",
      "has:tools",
      "minTokens:",
      "maxCost:",
    ].map((suggestion) => ({ label: suggestion, value: suggestion }));
  }

  let candidates: string[];
  switch (key) {
    case "agent":
    case "channel":
    case "provider":
    case "model":
    case "tool":
      candidates = options[key].slice(0, 6);
      break;
    case "has":
      candidates = ["errors", "tools", "context", "usage", "model", "provider"];
      break;
    default:
      return [];
  }
  return candidates
    .filter((candidate) => !value || normalizeLowercaseStringOrEmpty(candidate).includes(value))
    .map((candidate) => ({ label: `${key}:${candidate}`, value: `${key}:${candidate}` }));
};

const applySuggestionToQuery = (query: string, suggestion: string): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    return `${suggestion} `;
  }
  const tokens = extractQueryTerms(trimmed).map((term) => term.raw);
  tokens[tokens.length - 1] = suggestion;
  return `${tokens.join(" ")} `;
};

const removeQueryToken = (query: string, token: string): string => {
  const tokens = extractQueryTerms(query).map((term) => term.raw);
  const next = tokens.filter((entry) => entry !== token);
  return next.length ? `${next.join(" ")} ` : "";
};

const setQueryTokensForKey = (query: string, key: string, values: string[]): string => {
  const normalizedKey = normalizeLowercaseStringOrEmpty(key);
  const remaining = new Map(values.map((value) => [normalizeLowercaseStringOrEmpty(value), value]));
  const tokens: string[] = [];
  // Retained values keep their authored spelling and quotes; serialize only new selections.
  for (const term of extractQueryTerms(query)) {
    if (
      normalizeLowercaseStringOrEmpty(term.key ?? "") !== normalizedKey ||
      remaining.delete(normalizeLowercaseStringOrEmpty(term.value))
    ) {
      tokens.push(term.raw);
    }
  }
  const next = [...tokens, ...Array.from(remaining.values(), (value) => `${key}:${value}`)];
  return next.length ? `${next.join(" ")} ` : "";
};

export {
  applySuggestionToQuery,
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  removeQueryToken,
  setQueryTokensForKey,
};
