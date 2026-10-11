import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type UsageQueryTerm = {
  key?: string;
  value: string;
  raw: string;
};

type UsageQueryResult<TSession> = {
  sessions: TSession[];
  warnings: string[];
};

// Minimal shape required for query filtering. The usage view's real session type contains more fields.
type UsageSessionQueryTarget = {
  key: string;
  label?: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  chatType?: string;
  modelProvider?: string;
  providerOverride?: string;
  origin?: { provider?: string };
  model?: string;
  hasContextWeight?: boolean;
  usage?: {
    totalTokens?: number;
    totalCost?: number;
    messageCounts?: { total?: number; errors?: number };
    toolUsage?: { totalCalls?: number; tools?: Array<{ name: string }> };
    modelUsage?: Array<{ provider?: string; model?: string }>;
  } | null;
};

export function formatIsoDate(date: Date, timeZone: "local" | "utc" = "local"): string {
  const year = timeZone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const month = (timeZone === "utc" ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = timeZone === "utc" ? date.getUTCDate() : date.getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function createDefaultUsageDateRange(date = new Date()) {
  const start = new Date(date);
  start.setDate(start.getDate() - 29);
  return { startDate: formatIsoDate(start), endDate: formatIsoDate(date) };
}

export function toggleUsageRangeSelection<T>(
  selected: T[],
  value: T,
  orderedValues: T[],
  shiftKey: boolean,
  mode: "toggle" | "append" | "replace",
): T[] {
  if (shiftKey && selected.length > 0) {
    for (const lastSelected of selected.slice(-1)) {
      const lastIndex = orderedValues.indexOf(lastSelected);
      const nextIndex = orderedValues.indexOf(value);
      if (lastIndex !== -1 && nextIndex !== -1) {
        const [start, end] =
          lastIndex < nextIndex ? [lastIndex, nextIndex] : [nextIndex, lastIndex];
        return [...new Set([...selected, ...orderedValues.slice(start, end + 1)])];
      }
    }
  }
  if (mode === "replace") {
    return selected.length === 1 && selected[0] === value ? [] : [value];
  }
  if (selected.includes(value)) {
    return selected.filter((entry) => entry !== value);
  }
  return mode === "append" ? [...selected, value] : [value];
}

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
};

const parseQueryNumber = (value: string): number | null => {
  let raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return null;
  }
  if (raw.startsWith("$")) {
    raw = raw.slice(1);
  }
  let multiplier = 1;
  if (raw.endsWith("k")) {
    multiplier = 1_000;
    raw = raw.slice(0, -1);
  } else if (raw.endsWith("m")) {
    multiplier = 1_000_000;
    raw = raw.slice(0, -1);
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  const normalized = parsed * multiplier;
  if (!Number.isFinite(normalized) || !Number.isSafeInteger(Math.round(normalized))) {
    return null;
  }
  return normalized;
};

export const extractQueryTerms = (query: string): UsageQueryTerm[] => {
  const rawTokens = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  return rawTokens.map((token) => {
    const cleaned = token.replace(/^"(.*)"$/u, "$1");
    const idx = cleaned.indexOf(":");
    if (idx > 0) {
      const key = cleaned.slice(0, idx);
      const value = cleaned.slice(idx + 1).replace(/^"(.*)"$/u, "$1");
      return { key, value, raw: token };
    }
    return { value: cleaned, raw: token };
  });
};

const normalizeQueryValues = (items: Array<string | undefined>): string[] =>
  items
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeLowercaseStringOrEmpty(item));

const getSessionProviders = (session: UsageSessionQueryTarget): string[] =>
  normalizeQueryValues([
    session.modelProvider,
    session.providerOverride,
    session.origin?.provider,
    ...(session.usage?.modelUsage ?? []).map((entry) => entry.provider),
  ]);

const getSessionModels = (session: UsageSessionQueryTarget): string[] =>
  normalizeQueryValues([
    session.model,
    ...(session.usage?.modelUsage ?? []).map((entry) => entry.model),
  ]);

const getSessionTools = (session: UsageSessionQueryTarget): string[] =>
  (session.usage?.toolUsage?.tools ?? []).map((tool) => normalizeLowercaseStringOrEmpty(tool.name));

type UsageQueryPredicate = (session: UsageSessionQueryTarget) => boolean;

const HAS_PREDICATES: Readonly<Record<string, UsageQueryPredicate>> = {
  tools: (session) => (session.usage?.toolUsage?.totalCalls ?? 0) > 0,
  errors: (session) => (session.usage?.messageCounts?.errors ?? 0) > 0,
  context: (session) => session.hasContextWeight === true,
  usage: (session) => Boolean(session.usage),
  model: (session) => getSessionModels(session).length > 0,
  provider: (session) => getSessionProviders(session).length > 0,
};

type NumericQuerySpec = readonly [
  value: (session: UsageSessionQueryTarget) => number,
  matches: (value: number, threshold: number) => boolean,
];

const atLeast = (value: number, threshold: number): boolean => value >= threshold;
const atMost = (value: number, threshold: number): boolean => value <= threshold;
const NUMERIC_QUERY_SPECS: Readonly<Record<string, NumericQuerySpec>> = {
  mintokens: [(session) => session.usage?.totalTokens ?? 0, atLeast],
  maxtokens: [(session) => session.usage?.totalTokens ?? 0, atMost],
  mincost: [(session) => session.usage?.totalCost ?? 0, atLeast],
  maxcost: [(session) => session.usage?.totalCost ?? 0, atMost],
  minmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atLeast],
  maxmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atMost],
};

const QUERY_KEYS = new Set([
  "agent",
  "channel",
  "chat",
  "provider",
  "model",
  "tool",
  "label",
  "key",
  "session",
  "id",
  "has",
  ...Object.keys(NUMERIC_QUERY_SPECS),
]);
const MULTI_VALUE_QUERY_KEYS = new Set(["channel", "provider", "model", "tool"]);

const matchesEverySession: UsageQueryPredicate = () => true;

const prepareUsageQuery = (
  term: UsageQueryTerm,
  key: string,
  warnings: string[],
): UsageQueryPredicate => {
  if (term.key && !QUERY_KEYS.has(key)) {
    warnings.push(`Unknown filter: ${term.key}`);
    return matchesEverySession;
  }
  if (term.key && term.value === "") {
    warnings.push(`Missing value for ${term.key}`);
  }

  const value = normalizeLowercaseStringOrEmpty(term.value ?? "");
  const numericSpec = Object.hasOwn(NUMERIC_QUERY_SPECS, key)
    ? NUMERIC_QUERY_SPECS[key]
    : undefined;
  const threshold = numericSpec && term.value ? parseQueryNumber(term.value) : null;
  if (numericSpec && term.value && threshold === null) {
    warnings.push(`Invalid number for ${term.key}`);
  }
  if (key === "has") {
    const predicate = Object.hasOwn(HAS_PREDICATES, value) ? HAS_PREDICATES[value] : undefined;
    if (term.value && !predicate) {
      warnings.push(`Unknown has:${term.value}`);
    }
    return predicate ?? matchesEverySession;
  }
  if (!value) {
    return matchesEverySession;
  }
  if (!term.key) {
    return (session) =>
      normalizeQueryValues([session.label, session.key, session.sessionId]).some((text) =>
        text.includes(value),
      );
  }

  switch (key) {
    case "agent":
      return (session) => normalizeLowercaseStringOrEmpty(session.agentId).includes(value);
    case "channel":
      return (session) => normalizeLowercaseStringOrEmpty(session.channel).includes(value);
    case "chat":
      return (session) => normalizeLowercaseStringOrEmpty(session.chatType).includes(value);
    case "provider":
      return (session) => getSessionProviders(session).some((provider) => provider.includes(value));
    case "model":
      return (session) => getSessionModels(session).some((model) => model.includes(value));
    case "tool":
      return (session) => getSessionTools(session).some((tool) => tool.includes(value));
    case "label":
      return (session) => normalizeLowercaseStringOrEmpty(session.label).includes(value);
    case "key":
    case "session":
    case "id":
      if (value.includes("*") || value.includes("?")) {
        let regex: RegExp | undefined;
        return (session) => {
          // Preserve lazy construction after earlier predicates, then reuse this call's matcher.
          regex ??= globToRegex(value);
          return (
            regex.test(session.key) || (session.sessionId ? regex.test(session.sessionId) : false)
          );
        };
      }
      return (session) =>
        normalizeLowercaseStringOrEmpty(session.key).includes(value) ||
        normalizeLowercaseStringOrEmpty(session.sessionId).includes(value);
  }

  if (!numericSpec || threshold === null) {
    return matchesEverySession;
  }
  const [getValue, matches] = numericSpec;
  return (session) => matches(getValue(session), threshold);
};

export const filterSessionsByQuery = <TSession extends UsageSessionQueryTarget>(
  sessions: TSession[],
  query: string,
): UsageQueryResult<TSession> => {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) {
    return { sessions, warnings: [] };
  }

  const warnings: string[] = [];
  const categoricalTerms = new Map<string, UsageQueryPredicate[]>();
  const predicates = terms.map((term) => {
    const key = normalizeLowercaseStringOrEmpty(term.key ?? "");
    const predicate = prepareUsageQuery(term, key, warnings);
    if (!MULTI_VALUE_QUERY_KEYS.has(key)) {
      return predicate;
    }
    const alternatives = categoricalTerms.get(key) ?? [];
    if (term.value) {
      alternatives.push(predicate);
    }
    categoricalTerms.set(key, alternatives);
    // Every original term still revisits its completed OR group, including empty terms.
    return (session: UsageSessionQueryTarget) =>
      alternatives.length === 0 || alternatives.some((match) => match(session));
  });

  const filtered = sessions.filter((session) => predicates.every((match) => match(session)));
  return { sessions: filtered, warnings };
};

export function parseToolSummary(content: string) {
  const toolCounts = new Map<string, number>();
  const nonToolLines: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^\[Tool:\s*([^\]]+)\]/.exec(line.trim());
    const name = match?.[1];
    if (name) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      continue;
    }
    if (line.trim().startsWith("[Tool Result]")) {
      continue;
    }
    nonToolLines.push(line);
  }
  const sortedTools = Array.from(toolCounts).toSorted((a, b) => b[1] - a[1]);
  const totalCalls = sortedTools.reduce((sum, [, count]) => sum + count, 0);
  const summary =
    sortedTools.length > 0
      ? `Tools: ${sortedTools
          .map(([name, count]) => `${name}×${count}`)
          .join(", ")} (${totalCalls} calls)`
      : "";
  return {
    tools: sortedTools,
    summary,
    cleanContent: nonToolLines.join("\n").trim(),
  };
}
