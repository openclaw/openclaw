// The Gateway owns usage computation and cost attribution; this command only
// selects rows and formats them, like the other gateway-backed session verbs.
import type { SessionsUsageParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatMissingCostEntries } from "../infra/session-cost-usage-totals.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { SessionsUsageResult } from "../shared/usage-types.js";
import { formatTokenCount } from "../utils/token-format.js";
import { formatCostUsageCachePrefix, formatUsd } from "../utils/usage-format.js";

export const SESSIONS_USAGE_DEFAULT_LIMIT = 50;
export const SESSIONS_USAGE_MAX_LIMIT = 200;

const USAGE_RANGES = ["7d", "30d", "90d", "1y", "all"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type SessionsUsageOptions = {
  sessionKey?: string;
  agent?: string;
  all?: boolean;
  range?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  groupFamily?: boolean;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

function parseRange(raw: string | undefined): SessionsUsageParams["range"] | undefined {
  const range = raw?.trim();
  if (!range) {
    return undefined;
  }
  const match = USAGE_RANGES.find((candidate) => candidate === range);
  if (!match) {
    throw new Error(`--range must be one of ${USAGE_RANGES.join(", ")}.`);
  }
  return match;
}

function parseDate(raw: string | undefined, flag: string): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${flag} must be a YYYY-MM-DD date.`);
  }
  return value;
}

function describeRowLabel(row: SessionsUsageResult["sessions"][number]): string {
  const label = row.label ?? row.key;
  return sanitizeTerminalText(label).slice(0, 60);
}

function describeRowCost(row: SessionsUsageResult["sessions"][number]): string {
  const usage = row.usage;
  if (!usage) {
    return row.computing === true ? "computing…" : "—";
  }
  if (usage.totalCost === 0 && usage.missingCostEntries > 0) {
    return "unpriced";
  }
  return formatUsd(usage.totalCost) ?? "$0.00";
}

function describeRowTokens(row: SessionsUsageResult["sessions"][number]): string {
  if (!row.usage) {
    return row.computing === true ? "computing…" : "—";
  }
  return formatTokenCount(row.usage.totalTokens) ?? "0";
}

function describeRowMessages(row: SessionsUsageResult["sessions"][number]): string {
  if (!row.usage) {
    return row.computing === true ? "computing…" : "—";
  }
  return String(row.usage.messageCounts?.total ?? 0);
}

export function renderSessionsUsage(result?: SessionsUsageResult): string {
  const lines: string[] = [];
  const cachePrefix = formatCostUsageCachePrefix(result?.cacheStatus);
  if (cachePrefix) {
    lines.push(sanitizeTerminalText(cachePrefix).trimEnd());
  }
  lines.push(
    `${theme.heading("Session usage")} ${theme.muted(result ? `(${result.startDate} → ${result.endDate})` : "")}`,
  );
  const sessions = result?.sessions ?? [];
  if (sessions.length === 0) {
    lines.push("No session usage recorded in this range.");
  } else {
    lines.push(
      renderTable({
        width: getTerminalTableWidth(),
        columns: [
          { key: "Session", header: "Session", minWidth: 18, flex: true },
          { key: "Agent", header: "Agent", minWidth: 8 },
          { key: "Model", header: "Model", minWidth: 14 },
          { key: "Messages", header: "Messages", minWidth: 9 },
          { key: "Tokens", header: "Tokens", minWidth: 9 },
          { key: "Cost", header: "Cost", minWidth: 9 },
        ],
        rows: sessions.map((row) => ({
          Session: describeRowLabel(row),
          Agent: sanitizeTerminalText(row.agentId ?? "—").slice(0, 20),
          Model: sanitizeTerminalText(row.model ?? "—").slice(0, 30),
          Messages: describeRowMessages(row),
          Tokens: describeRowTokens(row),
          Cost: describeRowCost(row),
        })),
      }).trimEnd(),
    );
  }
  const totals = result?.totals;
  if (totals) {
    lines.push(
      `${theme.muted("Totals:")} ${formatUsd(totals.totalCost) ?? "$0.00"} · ${formatTokenCount(totals.totalTokens) ?? "0"} tokens · in ${formatTokenCount(totals.input) ?? "0"} / out ${formatTokenCount(totals.output) ?? "0"}`,
    );
    if (totals.missingCostEntries > 0) {
      lines.push(`${theme.muted("Missing cost:")} ${formatMissingCostEntries(totals)}`);
    }
  }
  const sessionCount = result?.aggregates?.sessionCount;
  if (typeof sessionCount === "number" && sessionCount > sessions.length) {
    lines.push(theme.muted(`${sessionCount} sessions match; showing ${sessions.length} rows.`));
  }
  if (result?.partial) {
    lines.push(theme.muted(`Partial report: ${sanitizeTerminalText(result.partial.message)}`));
  }
  return lines.join("\n");
}

export async function sessionsUsageCommand(
  opts: SessionsUsageOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const sessionKey = opts.sessionKey?.trim() || undefined;
  if (opts.sessionKey !== undefined && !sessionKey) {
    throw new Error("Session key must not be blank.");
  }
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  if (agent && opts.all) {
    throw new Error("Use --agent or --all, not both");
  }
  if (sessionKey && opts.all) {
    throw new Error("A session key cannot be combined with --all.");
  }
  const range = parseRange(opts.range);
  const startDate = parseDate(opts.startDate, "--start");
  const endDate = parseDate(opts.endDate, "--end");
  if ((startDate || endDate) && range) {
    throw new Error("Use --range or explicit --start/--end, not both");
  }
  if (endDate && !startDate) {
    throw new Error("--end requires --start.");
  }
  const limit = Math.min(
    Math.max(opts.limit ?? SESSIONS_USAGE_DEFAULT_LIMIT, 1),
    SESSIONS_USAGE_MAX_LIMIT,
  );

  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout ?? null,
    json: opts.json,
  };
  const params = {
    ...(sessionKey ? { key: sessionKey } : {}),
    ...(agent ? { agentId: agent } : {}),
    ...(opts.all ? { agentScope: "all" } : {}),
    ...(range ? { range } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(opts.groupFamily ? { groupBy: "family" } : {}),
    ...(limit !== SESSIONS_USAGE_DEFAULT_LIMIT ? { limit } : {}),
  };

  let result: SessionsUsageResult | undefined;
  try {
    result = await callGatewayFromCliWithTransport<SessionsUsageResult>(
      "sessions.usage",
      rpcOpts,
      params,
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), sessionKey });
    } else {
      runtime.error(`Usage read failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(renderSessionsUsage(result));
}
