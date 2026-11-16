import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import type { SessionsUsageOverview } from "../../../../src/shared/usage-types.js";
import type { CostDailyEntry, UsageSessionEntry } from "./usage-state-types.ts";

type CsvValue = string | number | undefined | null;

function toCsvRow(values: CsvValue[]): string {
  return values
    .map((value) => {
      if (value === undefined || value === null) {
        return "";
      }
      const text = String(value);
      const safeValue =
        typeof value === "string" && /^[ \t\r\n]*[=+\-@\uFF0B\uFF0D\uFF1D\uFF20]/u.test(text)
          ? `'${text}`
          : text;
      if (/[",\r\n]/.test(safeValue)) {
        return `"${safeValue.replaceAll('"', '""')}"`;
      }
      return safeValue;
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
    inputTokens: (session) => session.usage?.input,
    outputTokens: (session) => session.usage?.output,
    cacheReadTokens: (session) => session.usage?.cacheRead,
    cacheWriteTokens: (session) => session.usage?.cacheWrite,
    totalTokens: (session) => session.usage?.totalTokens,
    totalCost: (session) => session.usage?.totalCost,
  });

const buildDailyCsv = (daily: CostDailyEntry[]): string =>
  buildCsv(daily, {
    date: (day) => day.date,
    inputTokens: (day) => day.input,
    outputTokens: (day) => day.output,
    cacheReadTokens: (day) => day.cacheRead,
    cacheWriteTokens: (day) => day.cacheWrite,
    totalTokens: (day) => day.totalTokens,
    inputCost: (day) => day.inputCost,
    outputCost: (day) => day.outputCost,
    cacheReadCost: (day) => day.cacheReadCost,
    cacheWriteCost: (day) => day.cacheWriteCost,
    totalCost: (day) => day.totalCost,
  });

// The query parser splits on whitespace outside double quotes, so multiword values need quotes.
const formatQueryToken = (key: string, value: string): string =>
  /\s/u.test(value) ? `${key}:"${value}"` : `${key}:${value}`;

const buildQuerySuggestions = (
  query: string,
  terms: ReturnType<typeof extractQueryTerms>,
  options: SessionsUsageOverview["filterOptions"],
): {
  label: string;
  value: string;
}[] => {
  if (!query.trim()) {
    return [];
  }
  const lastTerm = terms.at(-1);
  const key = normalizeLowercaseStringOrEmpty(lastTerm?.key);
  const value = normalizeLowercaseStringOrEmpty(lastTerm?.value);

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
      candidates = options[key];
      break;
    case "has":
      candidates = ["errors", "tools", "context", "usage", "model", "provider"];
      break;
    default:
      return [];
  }
  return candidates
    .filter((candidate) => normalizeLowercaseStringOrEmpty(candidate).includes(value))
    .slice(0, 6)
    .map((candidate) => ({
      label: `${key}:${candidate}`,
      value: formatQueryToken(key, candidate),
    }));
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
  const next = [
    ...tokens,
    ...Array.from(remaining.values(), (value) => formatQueryToken(key, value)),
  ];
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
