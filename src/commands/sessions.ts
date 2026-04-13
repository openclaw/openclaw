import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveFreshSessionTotalTokens } from "../config/sessions.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import type { SessionsControlResult, SessionsInspectResult } from "../gateway/protocol/index.js";
import { classifySessionKey } from "../gateway/session-utils.js";
import { info } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  resolveSessionDisplayDefaults,
  resolveSessionDisplayModel,
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
  type SessionDisplayRow,
  toSessionDisplayRows,
} from "./sessions-table.js";

let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

type SessionRow = SessionDisplayRow & {
  agentId: string;
  kind: "direct" | "group" | "global" | "unknown";
};

const AGENT_PAD = 10;
const KIND_PAD = 6;
const TOKENS_PAD = 20;

const formatKTokens = (value: number) => `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) {
    return label;
  }
  if (pct >= 95) {
    return theme.error(label);
  }
  if (pct >= 80) {
    return theme.warn(label);
  }
  if (pct >= 60) {
    return theme.success(label);
  }
  return theme.muted(label);
};

const formatTokensCell = (
  total: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  if (total === undefined) {
    const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label.padEnd(TOKENS_PAD)) : label.padEnd(TOKENS_PAD);
  }
  const totalLabel = formatKTokens(total);
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  const pct = contextTokens ? Math.min(999, Math.round((total / contextTokens) * 100)) : null;
  const label = `${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`;
  const padded = label.padEnd(TOKENS_PAD);
  return colorByPct(padded, pct, rich);
};

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  const label = kind.padEnd(KIND_PAD);
  if (!rich) {
    return label;
  }
  if (kind === "group") {
    return theme.accentBright(label);
  }
  if (kind === "global") {
    return theme.warn(label);
  }
  if (kind === "direct") {
    return theme.accent(label);
  }
  return theme.muted(label);
};

export async function sessionsCommand(
  opts: { json?: boolean; store?: string; active?: string; agent?: string; allAgents?: boolean },
  runtime: RuntimeEnv,
) {
  const aggregateAgents = opts.allAgents === true;
  const cfg = loadConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
  const configContextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(displayDefaults.model) ??
    DEFAULT_CONTEXT_TOKENS;
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

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = Number.parseInt(opts.active, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      runtime.error("--active must be a positive integer (minutes)");
      runtime.exit(1);
      return;
    }
    activeMinutes = parsed;
  }

  const rows = targets
    .flatMap((target) => {
      const store = loadSessionStore(target.storePath);
      return toSessionDisplayRows(store).map((row) => ({
        ...row,
        agentId: parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
        kind: classifySessionKey(row.key, store[row.key]),
      }));
    })
    .filter((row) => {
      if (activeMinutes === undefined) {
        return true;
      }
      if (!row.updatedAt) {
        return false;
      }
      return Date.now() - row.updatedAt <= activeMinutes * 60_000;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (opts.json) {
    const multi = targets.length > 1;
    const aggregate = aggregateAgents || multi;
    writeRuntimeJson(runtime, {
      path: aggregate ? null : (targets[0]?.storePath ?? null),
      stores: aggregate
        ? targets.map((target) => ({
            agentId: target.agentId,
            path: target.storePath,
          }))
        : undefined,
      allAgents: aggregateAgents ? true : undefined,
      count: rows.length,
      activeMinutes: activeMinutes ?? null,
      sessions: rows.map((r) => {
        const model = resolveSessionDisplayModel(cfg, r, displayDefaults);
        return {
          ...r,
          totalTokens: resolveFreshSessionTotalTokens(r) ?? null,
          totalTokensFresh:
            typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
          contextTokens:
            r.contextTokens ?? lookupContextTokens(model) ?? configContextTokens ?? null,
          model,
        };
      }),
    });
    return;
  }

  if (targets.length === 1 && !aggregateAgents) {
    runtime.log(info(`Session store: ${targets[0]?.storePath}`));
  } else {
    runtime.log(
      info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`),
    );
  }
  runtime.log(info(`Sessions listed: ${rows.length}`));
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  const rich = isRich();
  const showAgentColumn = aggregateAgents || targets.length > 1;
  const header = [
    ...(showAgentColumn ? ["Agent".padEnd(AGENT_PAD)] : []),
    "Kind".padEnd(KIND_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Tokens (ctx %)".padEnd(TOKENS_PAD),
    "Flags",
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const model = resolveSessionDisplayModel(cfg, row, displayDefaults);
    const contextTokens = row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
    const total = resolveFreshSessionTotalTokens(row);

    const line = [
      ...(showAgentColumn
        ? [rich ? theme.accentBright(row.agentId.padEnd(AGENT_PAD)) : row.agentId.padEnd(AGENT_PAD)]
        : []),
      formatKindCell(row.kind, rich),
      formatSessionKeyCell(row.key, rich),
      formatSessionAgeCell(row.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatTokensCell(total, contextTokens ?? null, rich),
      formatSessionFlagsCell(row, rich),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}

function formatMaybeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return "[function]";
  }
  return "n/a";
}

function formatInspectCounts(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "n/a";
  }
  const entries = Object.entries(value)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([status, count]) => `${status}=${count}`);
  return entries.length > 0 ? entries.join(", ") : "none";
}

function logInspectSection(
  runtime: RuntimeEnv,
  heading: string,
  lines: Array<[label: string, value: unknown]>,
) {
  runtime.log(theme.heading(heading));
  for (const [label, value] of lines) {
    runtime.log(`${label}: ${formatMaybeValue(value)}`);
  }
}

async function callGatewayForSessions<T>(options: CallGatewayOptions): Promise<T> {
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway<T>(options);
}

export async function sessionsInspectCommand(
  opts: { key: string; json?: boolean; timeoutMs?: number },
  runtime: RuntimeEnv,
) {
  const payload = await callGatewayForSessions<SessionsInspectResult>({
    method: "sessions.inspect",
    params: {
      key: opts.key,
    },
    timeoutMs: opts.timeoutMs,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  const session = payload.session;
  const plan = payload.plan;
  const worktree = payload.worktree;
  const team = payload.team;
  const policy = payload.policy;

  runtime.log(info(`Session: ${formatMaybeValue(payload.key)}`));
  runtime.log(info(`Exists: ${payload.exists ? "yes" : "no"}`));

  if (session) {
    logInspectSection(runtime, "Session", [
      ["sessionId", session.sessionId],
      ["status", session.status],
      ["label", session.label],
      ["displayName", session.displayName],
      ["model", [session.modelProvider, session.model].filter(Boolean).join("/") || session.model],
      ["kind", session.kind],
      ["spawnedBy", session.spawnedBy],
      ["spawnedWorkspaceDir", session.spawnedWorkspaceDir],
      ["parentSessionKey", session.parentSessionKey],
      ["spawnDepth", session.spawnDepth],
      ["subagentRole", session.subagentRole],
      ["subagentControlScope", session.subagentControlScope],
    ]);
  }

  if (plan) {
    const artifact = plan.artifact;
    logInspectSection(runtime, "Plan", [
      ["mode", plan.mode],
      ["status", artifact?.status],
      ["goal", artifact?.goal],
      ["summary", artifact?.summary],
      ["lastExplanation", artifact?.lastExplanation],
      ["steps", Array.isArray(artifact?.steps) ? artifact?.steps.length : 0],
    ]);
  }

  if (worktree) {
    const artifact = worktree.artifact;
    logInspectSection(runtime, "Worktree", [
      ["mode", worktree.mode],
      ["status", artifact?.status],
      ["repoRoot", artifact?.repoRoot],
      ["worktreeDir", artifact?.worktreeDir],
      ["branch", artifact?.branch],
      ["cleanupPolicy", artifact?.cleanupPolicy],
      ["preferredWorkspaceDir", worktree.preferredWorkspaceDir],
      ["lastError", artifact?.lastError],
    ]);
  }

  if (team) {
    logInspectSection(runtime, "Team", [
      ["teamId", team.teamId],
      ["flowStatus", team.flowStatus],
      ["currentStep", team.currentStep],
      ["summary", team.summary],
      ["activeWorkers", team.activeWorkers],
      ["counts", formatInspectCounts(team.counts)],
      ["worktreeDir", team.worktreeDir],
    ]);
  }

  if (policy) {
    logInspectSection(runtime, "Policy", [
      ["sendPolicy", policy.sendPolicy],
      ["groupActivation", policy.groupActivation],
      ["execHost", policy.execHost],
      ["execSecurity", policy.execSecurity],
      ["execAsk", policy.execAsk],
      ["execNode", policy.execNode],
      ["responseUsage", policy.responseUsage],
    ]);
  }
}

export async function sessionsControlCommand(
  opts: {
    key: string;
    json?: boolean;
    timeoutMs?: number;
    exitPlan?: boolean;
    planStatus?: string;
    planSummary?: string;
    approved?: boolean;
    exitWorktree?: boolean;
    cleanup?: string;
    force?: boolean;
    closeTeam?: boolean;
    teamId?: string;
    teamSummary?: string;
    cancelActive?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const planRequested = opts.exitPlan === true;
  const worktreeRequested = opts.exitWorktree === true;
  const teamRequested = opts.closeTeam === true;
  if (!planRequested && !worktreeRequested && !teamRequested) {
    runtime.error(
      "sessions control needs at least one action: --exit-plan, --exit-worktree, or --close-team",
    );
    runtime.exit(1);
    return;
  }

  if (
    opts.planStatus !== undefined &&
    opts.planStatus !== "completed" &&
    opts.planStatus !== "cancelled"
  ) {
    runtime.error('--plan-status must be "completed" or "cancelled"');
    runtime.exit(1);
    return;
  }
  if (opts.cleanup !== undefined && opts.cleanup !== "keep" && opts.cleanup !== "remove") {
    runtime.error('--cleanup must be "keep" or "remove"');
    runtime.exit(1);
    return;
  }

  const payload = await callGatewayForSessions<SessionsControlResult>({
    method: "sessions.control",
    params: {
      key: opts.key,
      ...(planRequested
        ? {
            plan: {
              exit: true,
              ...(opts.planStatus ? { status: opts.planStatus } : {}),
              ...(opts.planSummary ? { summary: opts.planSummary } : {}),
              ...(opts.approved === true ? { approved: true } : {}),
            },
          }
        : {}),
      ...(worktreeRequested
        ? {
            worktree: {
              exit: true,
              ...(opts.cleanup ? { cleanup: opts.cleanup } : {}),
              ...(opts.force === true ? { force: true } : {}),
            },
          }
        : {}),
      ...(teamRequested
        ? {
            team: {
              close: true,
              ...(opts.teamId ? { teamId: opts.teamId } : {}),
              ...(opts.teamSummary ? { summary: opts.teamSummary } : {}),
              ...(opts.cancelActive !== undefined ? { cancelActive: opts.cancelActive } : {}),
            },
          }
        : {}),
    },
    timeoutMs: opts.timeoutMs,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(info(`Session: ${formatMaybeValue(payload.key)}`));
  const actions = payload.actions;
  if (!actions) {
    runtime.log("No actions applied.");
    return;
  }

  if (actions.plan) {
    const plan = actions.plan;
    const artifact = plan.artifact;
    runtime.log(
      `plan: mode=${formatMaybeValue(plan.mode)} status=${formatMaybeValue(artifact?.status)} summary=${formatMaybeValue(artifact?.summary)}`,
    );
  }
  if (actions.worktree) {
    const worktree = actions.worktree;
    runtime.log(
      `worktree: status=${formatMaybeValue(worktree.status)} cleanup=${formatMaybeValue(worktree.cleanup)} removed=${formatMaybeValue(worktree.removed)} dirty=${formatMaybeValue(worktree.dirty)}`,
    );
    if (worktree.error) {
      runtime.log(`worktree-error: ${formatMaybeValue(worktree.error)}`);
    }
  }
  if (actions.team) {
    const team = actions.team;
    runtime.log(
      `team: id=${formatMaybeValue(team.teamId)} flowStatus=${formatMaybeValue(team.flowStatus)} activeWorkers=${formatMaybeValue(team.activeWorkers)} counts=${formatInspectCounts(team.counts)}`,
    );
  }
}
