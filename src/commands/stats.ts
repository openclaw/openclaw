/**
 * Usage statistics command.
 *
 * Aggregates per-session token usage and estimated cost from one or more agent
 * session stores into overall totals plus per-agent and per-provider
 * breakdowns. Read-only: it reuses the same session accessor as `sessions` and
 * never writes state.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../cli/parse-duration.js";
import { getRuntimeConfig } from "../config/config.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

/** CLI options accepted by `openclaw stats usage`. */
export type StatsUsageOptions = {
  json?: boolean;
  store?: string;
  agent?: string;
  allAgents?: boolean;
  since?: string;
  until?: string;
  provider?: string;
};

/** Aggregated usage counters shared by overall totals and breakdown rows. */
type UsageTotals = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

/** A named breakdown row (per agent or per provider). */
type UsageBreakdownRow = UsageTotals & { name: string };

const UNKNOWN_PROVIDER = "unknown";

function emptyTotals(): UsageTotals {
  return {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

function resolveNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Adds one session's usage into a totals accumulator. Token totals sum the
 * per-run input/output counts rather than `entry.totalTokens`, which is a
 * context-window snapshot for the latest run and is not additive across
 * sessions.
 */
function addSessionUsage(totals: UsageTotals, entry: SessionEntry): void {
  const input = resolveNonNegative(entry.inputTokens);
  const output = resolveNonNegative(entry.outputTokens);
  totals.sessions += 1;
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.totalTokens += input + output;
  totals.estimatedCostUsd += resolveNonNegative(entry.estimatedCostUsd);
}

function upsertBreakdown(map: Map<string, UsageTotals>, key: string, entry: SessionEntry): void {
  const totals = map.get(key) ?? emptyTotals();
  addSessionUsage(totals, entry);
  map.set(key, totals);
}

/** Sort breakdown rows by total tokens descending, then name ascending, for stable output. */
function toSortedBreakdown(map: Map<string, UsageTotals>): UsageBreakdownRow[] {
  return Array.from(map, ([name, totals]) => ({ name, ...totals })).toSorted(
    (left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name),
  );
}

/**
 * Parses a `--since`/`--until` bound. Values containing a date separator
 * (`-`, `:`, `T`, `/`) are treated as absolute dates; everything else is a
 * duration relative to now (e.g. `7d`, `24h`), with bare numbers meaning days.
 */
function parseTimeBound(raw: string, flag: string): number {
  const trimmed = raw.trim();
  if (/[-:T/]/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid ${flag} date: "${raw}". Use an ISO date like 2026-01-31.`);
    }
    return parsed;
  }
  // parseDurationMs throws with its own guidance for malformed durations.
  return Date.now() - parseDurationMs(trimmed, { defaultUnit: "d" });
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatBreakdownRow(row: UsageBreakdownRow): string {
  return [
    `  ${row.name}`,
    `sessions=${formatInt(row.sessions)}`,
    `in=${formatInt(row.inputTokens)}`,
    `out=${formatInt(row.outputTokens)}`,
    `total=${formatInt(row.totalTokens)}`,
    `cost=${formatCost(row.estimatedCostUsd)}`,
  ].join("  ");
}

/** Aggregates and reports token usage across the selected session stores. */
export async function statsUsageCommand(
  opts: StatsUsageOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  try {
    sinceMs = opts.since !== undefined ? parseTimeBound(opts.since, "--since") : undefined;
    untilMs = opts.until !== undefined ? parseTimeBound(opts.until, "--until") : undefined;
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    runtime.exit(1);
    return;
  }

  const providerFilter = normalizeOptionalLowercaseString(opts.provider);

  const overall = emptyTotals();
  const byAgent = new Map<string, UsageTotals>();
  const byProvider = new Map<string, UsageTotals>();

  for (const target of targets) {
    const entries = listSessionEntries({ agentId: target.agentId, storePath: target.storePath });
    for (const { entry } of entries) {
      const updatedAt = entry.updatedAt;
      if (sinceMs !== undefined && !(typeof updatedAt === "number" && updatedAt >= sinceMs)) {
        continue;
      }
      if (untilMs !== undefined && !(typeof updatedAt === "number" && updatedAt <= untilMs)) {
        continue;
      }
      const provider = normalizeOptionalLowercaseString(entry.modelProvider);
      if (providerFilter !== undefined && provider !== providerFilter) {
        continue;
      }
      addSessionUsage(overall, entry);
      upsertBreakdown(byAgent, target.agentId, entry);
      upsertBreakdown(byProvider, provider ?? UNKNOWN_PROVIDER, entry);
    }
  }

  const agentRows = toSortedBreakdown(byAgent);
  const providerRows = toSortedBreakdown(byProvider);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      stores: targets.map((target) => ({ agentId: target.agentId, path: target.storePath })),
      allAgents: opts.allAgents === true ? true : undefined,
      since: sinceMs !== undefined ? new Date(sinceMs).toISOString() : null,
      until: untilMs !== undefined ? new Date(untilMs).toISOString() : null,
      provider: providerFilter ?? null,
      totals: overall,
      byAgent: agentRows,
      byProvider: providerRows,
    });
    return;
  }

  const scope =
    targets.length === 1 && targets[0]
      ? `Session store: ${targets[0].storePath}`
      : `Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`;
  runtime.log(scope);

  const filters: string[] = [];
  if (sinceMs !== undefined) {
    filters.push(`since ${new Date(sinceMs).toISOString()}`);
  }
  if (untilMs !== undefined) {
    filters.push(`until ${new Date(untilMs).toISOString()}`);
  }
  if (providerFilter !== undefined) {
    filters.push(`provider ${providerFilter}`);
  }
  if (filters.length > 0) {
    runtime.log(`Filters: ${filters.join(", ")}`);
  }

  runtime.log(`Sessions: ${formatInt(overall.sessions)}`);
  runtime.log(`Input tokens: ${formatInt(overall.inputTokens)}`);
  runtime.log(`Output tokens: ${formatInt(overall.outputTokens)}`);
  runtime.log(`Total tokens: ${formatInt(overall.totalTokens)}`);
  runtime.log(`Estimated cost: ${formatCost(overall.estimatedCostUsd)}`);

  if (overall.sessions === 0) {
    runtime.log("No matching sessions found.");
    return;
  }

  if (agentRows.length > 1) {
    runtime.log("By agent:");
    for (const row of agentRows) {
      runtime.log(formatBreakdownRow(row));
    }
  }
  runtime.log("By provider:");
  for (const row of providerRows) {
    runtime.log(formatBreakdownRow(row));
  }
}
