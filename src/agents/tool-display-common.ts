import {
  asPositiveFiniteNumber,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactToolPayloadText } from "../logging/redact.js";
import { isAgentPlanProgressToolName } from "../session-cards/progress-card-input.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { resolveExecDetail, type ToolDetailMode } from "./tool-display-exec.js";

type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

export type ToolDisplaySpec = {
  title?: string;
  label?: string;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

type CoerceDisplayValueOptions = {
  includeFalsy?: boolean;
};

export function normalizeToolDisplayName(name?: string): string {
  return (name ?? "tool").trim();
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) => `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Beyond this nesting depth, a value does not contribute to the compact display preview. */
const TOOL_DISPLAY_ARRAY_DEPTH_LIMIT = 64;

function coerceDisplayValue(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
  depth = 0,
): string | undefined {
  if (depth > TOOL_DISPLAY_ARRAY_DEPTH_LIMIT) {
    return undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const rawLine = normalizeOptionalString(trimmed.split(/\r?\n/, 1)[0]) ?? "";
    if (!rawLine) {
      return undefined;
    }
    const firstLine = redactToolPayloadText(rawLine);
    if (firstLine.length > 160) {
      return `${sliceUtf16Safe(firstLine, 0, 79)}…${sliceUtf16Safe(firstLine, -80)}`;
    }
    return firstLine;
  }
  if (typeof value === "boolean") {
    if (!value && !opts.includeFalsy) {
      return undefined;
    }
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (value === 0 && !opts.includeFalsy) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      const display = coerceDisplayValue(item, opts, depth + 1);
      if (!display) {
        continue;
      }
      // The fourth visible value determines the ellipsis; later items cannot affect the preview.
      if (values.length === 3) {
        return `${values.join(", ")}…`;
      }
      values.push(display);
    }
    return values.length > 0 ? values.join(", ") : undefined;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split(".")) {
    if (!segment) {
      return undefined;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}

export function formatDetailKey(raw: string, overrides: Record<string, string>): string {
  const last = raw.split(".").findLast(Boolean) || raw;
  const override = overrides[last];
  if (override) {
    return override;
  }
  const cleaned = last.replace(/[_-]/g, " ");
  const spaced = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return normalizeLowercaseStringOrEmpty(spaced) || normalizeLowercaseStringOrEmpty(last);
}

function resolvePathArg(record: Record<string, unknown>): string | undefined {
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    const trimmed = normalizeOptionalString(candidate);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveReadDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record);
  if (!path) {
    return undefined;
  }

  const offset = resolveOptionalIntegerOption(record.offset, { min: 1 });
  const limit = resolveOptionalIntegerOption(record.limit, { min: 1 });

  if (offset !== undefined && limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `${unit} ${offset}-${offset + limit - 1} from ${path}`;
  }
  if (offset !== undefined) {
    return `from line ${offset} in ${path}`;
  }
  if (limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `first ${limit} ${unit} of ${path}`;
  }
  return `from ${path}`;
}

function resolveWriteDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record) ?? normalizeOptionalString(record.url);
  if (!path) {
    return undefined;
  }

  if (toolKey === "attach") {
    return `from ${path}`;
  }

  const destinationPrefix = toolKey === "edit" ? "in" : "to";
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;

  if (content) {
    return `${destinationPrefix} ${path} (${content.length} chars)`;
  }

  return `${destinationPrefix} ${path}`;
}

function resolveWebSearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const queries = collectWebSearchQueries(record);
  const count =
    asPositiveFiniteNumber(record.count) ??
    asPositiveFiniteNumber(record.max_results) ??
    asPositiveFiniteNumber(record.num_results) ??
    asPositiveFiniteNumber(record.limit) ??
    asPositiveFiniteNumber(record.top_k);

  if (queries.length === 0) {
    return undefined;
  }

  const displayedQueries = queries.slice(0, 3).map((query) => `"${query}"`);
  const queryText =
    queries.length > displayedQueries.length
      ? `${displayedQueries.join(", ")}…`
      : displayedQueries.join(", ");

  return count !== undefined ? `for ${queryText} (top ${Math.floor(count)})` : `for ${queryText}`;
}

function collectWebSearchQueries(record: Record<string, unknown>): string[] {
  const queries = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      queries.add(normalized);
    }
  };

  add(record.query);
  add(record.q);
  add(record.search);
  add(record.input);
  // Parallel's `web_search` provider uses the native Parallel Search shape
  // (`objective` + `search_queries`). Surface those so CLI progress and
  // Codex activity metadata render the query context instead of a bare
  // `search`.
  add(record.objective);

  for (const key of ["search_query", "image_query", "queries", "search_queries"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        add(entry);
        continue;
      }
      const entryRecord = asRecord(entry);
      if (!entryRecord) {
        continue;
      }
      add(entryRecord.query);
      add(entryRecord.q);
      add(entryRecord.search);
    }
  }

  return [...queries];
}

function resolveWebFetchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const url = normalizeOptionalString(record.url);
  if (!url) {
    return undefined;
  }

  const mode = normalizeOptionalString(record.extractMode);
  const maxChars = asPositiveFiniteNumber(record.maxChars);

  const suffix = [
    mode ? `mode ${mode}` : "",
    maxChars === undefined ? "" : `max ${Math.floor(maxChars)} chars`,
  ]
    .filter(Boolean)
    .join(", ");

  return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}

function resolveDetailFromKeys(
  args: unknown,
  keys: string[],
  opts: {
    mode: "first" | "summary";
    coerce?: CoerceDisplayValueOptions;
    formatKey?: (raw: string) => string;
  },
): string | undefined {
  const entries: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value, opts.coerce);
    if (!display) {
      continue;
    }
    if (opts.mode === "first") {
      return display;
    }
    entries.push({ label: opts.formatKey ? opts.formatKey(key) : key, value: display });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries.at(0)?.value;
  }

  const unique = dedupeByKey(entries, (entry) => `${entry.label}:${entry.value}`);
  const parts: string[] = [];
  for (let index = 0; index < unique.length && index < 8; index += 1) {
    const entry = unique[index];
    if (entry) {
      parts.push(`${entry.label} ${entry.value}`);
    }
  }
  return parts.join(", ");
}

export function resolveToolVerbAndDetailForArgs(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: "first" | "summary";
  toolDetailMode?: ToolDetailMode;
  detailCoerce?: CoerceDisplayValueOptions;
  detailFormatKey?: (raw: string) => string;
}): { verb?: string; detail?: string } {
  // Card arguments belong to the card renderer; generic summaries must not expose them.
  if (isAgentPlanProgressToolName(params.toolKey)) {
    return {};
  }
  // Keep the existing read order when caller-owned options expose accessors.
  const { toolKey, args, meta } = params;
  const action = normalizeOptionalString(asRecord(params.args)?.action);
  const { spec, fallbackDetailKeys, detailMode, toolDetailMode, detailCoerce, detailFormatKey } =
    params;
  const actionSpec = spec && action ? (spec.actions?.[action] ?? undefined) : undefined;
  const fallbackVerb =
    toolKey === "web_search"
      ? "search"
      : toolKey === "web_fetch"
        ? "fetch"
        : toolKey.replace(/[_.]/g, " ");
  const verb = normalizeOptionalString(actionSpec?.label ?? action ?? fallbackVerb)?.replace(
    /_/g,
    " ",
  );

  let detail: string | undefined;
  if (toolKey === "exec" || toolKey === "bash" || toolKey === "shell") {
    detail = resolveExecDetail(args, { detailMode: toolDetailMode });
  }
  if (!detail && toolKey === "read") {
    detail = resolveReadDetail(args);
  }
  if (!detail && (toolKey === "write" || toolKey === "edit" || toolKey === "attach")) {
    detail = resolveWriteDetail(toolKey, args);
  }
  if (!detail && toolKey === "web_search") {
    detail = resolveWebSearchDetail(args);
  }
  if (!detail && toolKey === "web_fetch") {
    detail = resolveWebFetchDetail(args);
  }

  const detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? fallbackDetailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(args, detailKeys, {
      mode: detailMode,
      coerce: detailCoerce,
      formatKey: detailFormatKey,
    });
  }
  if (!detail && meta) {
    detail = meta;
  }
  return { verb, detail };
}
