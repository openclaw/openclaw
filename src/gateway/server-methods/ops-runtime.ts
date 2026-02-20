import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import { loadSubagentRegistryFromDisk } from "../../agents/subagent-registry.store.js";
import { loadConfig } from "../../config/config.js";
import type { CronJob } from "../../cron/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { listSessionsFromStore, loadCombinedSessionStoreForGateway } from "../session-utils.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_ACTIVE_MINUTES = 60;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const SESSION_SCAN_LIMIT = 500;

type OpsRuntimeParams = {
  activeMinutes: number;
  limit: number;
  search: string;
  fromMs?: number;
  toMs?: number;
  includeDisabledCron: boolean;
};

type OpsRuntimeSessionItem = {
  key: string;
  agentId: string;
  status: "running" | "warning" | "idle";
  updatedAt: number | null;
  ageMs: number | null;
  model?: string;
  title: string;
};

type OpsRuntimeSubagentItem = {
  runId: string;
  label: string;
  status: "running" | "error" | "done";
  requesterSessionKey: string;
  childSessionKey: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
};

type OpsRuntimeCronItem = {
  id: string;
  name: string;
  enabled: boolean;
  lastRunAtMs?: number;
  runningAtMs?: number;
  lastStatus?: string;
  consecutiveErrors: number;
  lastError?: string;
};

export const opsRuntimeHandlers: GatewayRequestHandlers = {
  "ops.runtime.summary": async ({ params, respond, context }) => {
    const normalized = normalizeParams(params);
    if (!normalized.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalized.error));
      return;
    }

    const filters = normalized.value;
    const now = Date.now();

    try {
      const cfg = loadConfig();
      const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
      const sessionsResult = listSessionsFromStore({
        cfg,
        storePath,
        store,
        opts: {
          includeGlobal: false,
          includeUnknown: false,
          activeMinutes: filters.activeMinutes,
          search: filters.search || undefined,
          limit: SESSION_SCAN_LIMIT,
        },
      });

      const sessionItems = sessionsResult.sessions
        .map((session) => toSessionItem(session, now, resolveDefaultAgentId(cfg), filters))
        .filter((item): item is OpsRuntimeSessionItem => item !== null);

      const allCronJobs = await context.cron.list({
        includeDisabled: filters.includeDisabledCron,
      });
      const cronItems = allCronJobs
        .map((job) => toCronItem(job))
        .filter((job) => matchesCronFilters(job, filters, now));

      const allSubagents = [...loadSubagentRegistryFromDisk().values()];
      const subagentItems = allSubagents
        .map((entry) => toSubagentItem(entry, now))
        .filter((item): item is OpsRuntimeSubagentItem => item !== null)
        .filter((item) => matchesSubagentFilters(item, filters, now));

      const sessions = sessionItems
        .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, filters.limit);
      const cron = cronItems
        .toSorted(
          (a, b) => (b.lastRunAtMs ?? b.runningAtMs ?? 0) - (a.lastRunAtMs ?? a.runningAtMs ?? 0),
        )
        .slice(0, filters.limit);
      const subagents = subagentItems
        .toSorted((a, b) => (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0))
        .slice(0, filters.limit);

      const activeCutoff = now - filters.activeMinutes * 60_000;
      const cronErrors = cron.filter((item) => isCronError(item)).length;
      const cronWarnings = cron.filter((item) => isCronWarning(item)).length;
      const activeSessions = sessions.filter(
        (item) => item.status === "running" && (item.updatedAt ?? 0) >= activeCutoff,
      ).length;
      const warningSessions = sessions.filter((item) => item.status === "warning").length;
      const activeSubagents = subagents.filter((item) => item.status === "running").length;
      const erroredSubagents = subagents.filter((item) => item.status === "error").length;

      const payload = {
        ts: now,
        filters: {
          activeMinutes: filters.activeMinutes,
          limit: filters.limit,
          search: filters.search || null,
          fromMs: filters.fromMs ?? null,
          toMs: filters.toMs ?? null,
          includeDisabledCron: filters.includeDisabledCron,
        },
        summary: {
          cron: {
            total: cron.length,
            enabled: cron.filter((item) => item.enabled).length,
            warnings: cronWarnings,
            errors: cronErrors,
          },
          sessions: {
            total: sessions.length,
            active: activeSessions,
            warnings: warningSessions,
          },
          subagents: {
            total: subagents.length,
            active: activeSubagents,
            errors: erroredSubagents,
          },
        },
        cron,
        sessions,
        subagents,
      };

      respond(true, payload, undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
};

function normalizeParams(
  input: unknown,
): { ok: true; value: OpsRuntimeParams } | { ok: false; error: string } {
  if (input != null && typeof input !== "object") {
    return { ok: false, error: "ops.runtime.summary params must be an object" };
  }

  const params = (input ?? {}) as Record<string, unknown>;
  const activeMinutesRaw = params.activeMinutes;
  const limitRaw = params.limit;
  const searchRaw = params.search;
  const fromMsRaw = params.fromMs;
  const toMsRaw = params.toMs;
  const includeDisabledCronRaw = params.includeDisabledCron;

  const activeMinutes = toPositiveInt(activeMinutesRaw, DEFAULT_ACTIVE_MINUTES);
  if (!activeMinutes) {
    return { ok: false, error: "activeMinutes must be a positive integer" };
  }

  const limit = toPositiveInt(limitRaw, DEFAULT_LIMIT);
  if (!limit) {
    return { ok: false, error: "limit must be a positive integer" };
  }

  const fromMs = toOptionalMs(fromMsRaw);
  if (fromMsRaw !== undefined && fromMs === undefined) {
    return { ok: false, error: "fromMs must be a valid unix timestamp in milliseconds" };
  }
  const toMs = toOptionalMs(toMsRaw);
  if (toMsRaw !== undefined && toMs === undefined) {
    return { ok: false, error: "toMs must be a valid unix timestamp in milliseconds" };
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    return { ok: false, error: "fromMs cannot be greater than toMs" };
  }

  const search = typeof searchRaw === "string" ? searchRaw.trim().toLowerCase().slice(0, 200) : "";
  const includeDisabledCron = includeDisabledCronRaw === true;

  return {
    ok: true,
    value: {
      activeMinutes,
      limit: Math.min(limit, MAX_LIMIT),
      search,
      fromMs,
      toMs,
      includeDisabledCron,
    },
  };
}

function toPositiveInt(value: unknown, fallback: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const parsed = Math.floor(num);
  if (parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function toOptionalMs(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return undefined;
  }
  return Math.floor(num);
}

function toSessionItem(
  row: GatewaySessionRow,
  now: number,
  defaultAgentId: string,
  filters: OpsRuntimeParams,
): OpsRuntimeSessionItem | null {
  const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : null;
  if (!withinTimeRange(updatedAt, filters.fromMs, filters.toMs)) {
    return null;
  }
  const agentId = parseAgentSessionKey(row.key)?.agentId ?? defaultAgentId;
  const title = row.derivedTitle ?? row.displayName ?? row.label ?? row.key;
  if (!matchesSearch(filters.search, [title, row.key, row.model, agentId])) {
    return null;
  }
  const ageMs = updatedAt != null ? Math.max(0, now - updatedAt) : null;
  const activeCutoff = now - filters.activeMinutes * 60_000;
  const status: OpsRuntimeSessionItem["status"] = row.abortedLastRun
    ? "warning"
    : updatedAt != null && updatedAt >= activeCutoff
      ? "running"
      : "idle";
  return {
    key: row.key,
    agentId,
    status,
    updatedAt,
    ageMs,
    model: row.model,
    title,
  };
}

function toCronItem(job: CronJob): OpsRuntimeCronItem {
  const state = job.state ?? {};
  return {
    id: job.id,
    name: job.name,
    enabled: Boolean(job.enabled),
    lastRunAtMs: numberOrUndefined(state.lastRunAtMs),
    runningAtMs: numberOrUndefined(state.runningAtMs),
    lastStatus: typeof state.lastStatus === "string" ? state.lastStatus : undefined,
    consecutiveErrors: Number.isFinite(Number(state.consecutiveErrors))
      ? Math.max(0, Number(state.consecutiveErrors))
      : 0,
    lastError: typeof state.lastError === "string" ? state.lastError : undefined,
  };
}

function matchesCronFilters(
  item: OpsRuntimeCronItem,
  filters: OpsRuntimeParams,
  now: number,
): boolean {
  const activeCutoff = now - filters.activeMinutes * 60_000;
  const timeAnchor = item.runningAtMs ?? item.lastRunAtMs;
  if (!withinTimeRange(timeAnchor, filters.fromMs, filters.toMs)) {
    return false;
  }
  if (
    item.runningAtMs === undefined &&
    item.lastRunAtMs !== undefined &&
    item.lastRunAtMs < activeCutoff &&
    filters.fromMs === undefined &&
    filters.toMs === undefined
  ) {
    return false;
  }
  if (!matchesSearch(filters.search, [item.id, item.name, item.lastStatus, item.lastError])) {
    return false;
  }
  return true;
}

function isCronError(item: OpsRuntimeCronItem): boolean {
  const lastStatus = (item.lastStatus ?? "").toLowerCase();
  return lastStatus === "error" || lastStatus === "failed";
}

function isCronWarning(item: OpsRuntimeCronItem): boolean {
  if (isCronError(item)) {
    return true;
  }
  if (item.consecutiveErrors > 0) {
    return true;
  }
  return Boolean(item.lastError && /timeout|timed out/i.test(item.lastError));
}

function toSubagentItem(entry: SubagentRunRecord, now: number): OpsRuntimeSubagentItem | null {
  if (!entry.runId || !entry.requesterSessionKey || !entry.childSessionKey) {
    return null;
  }
  const startedAt = numberOrUndefined(entry.startedAt ?? entry.createdAt);
  const endedAt = numberOrUndefined(entry.endedAt);
  const isRunning = typeof endedAt !== "number";
  const status: OpsRuntimeSubagentItem["status"] = isRunning
    ? "running"
    : entry.outcome?.status === "error" || entry.outcome?.status === "timeout"
      ? "error"
      : "done";
  const durationMs =
    typeof startedAt === "number" ? Math.max(0, (endedAt ?? now) - startedAt) : undefined;
  return {
    runId: entry.runId,
    label: entry.label?.trim() || entry.task?.trim() || entry.runId,
    status,
    requesterSessionKey: entry.requesterSessionKey,
    childSessionKey: entry.childSessionKey,
    model: entry.model,
    startedAt,
    endedAt,
    durationMs,
  };
}

function matchesSubagentFilters(
  item: OpsRuntimeSubagentItem,
  filters: OpsRuntimeParams,
  now: number,
): boolean {
  const anchor = item.startedAt ?? item.endedAt;
  if (!withinTimeRange(anchor, filters.fromMs, filters.toMs)) {
    return false;
  }
  if (
    filters.fromMs === undefined &&
    filters.toMs === undefined &&
    item.status !== "running" &&
    typeof item.endedAt === "number" &&
    item.endedAt < now - filters.activeMinutes * 60_000
  ) {
    return false;
  }
  return matchesSearch(filters.search, [
    item.runId,
    item.label,
    item.model,
    item.requesterSessionKey,
    item.childSessionKey,
    item.status,
  ]);
}

function withinTimeRange(ts: number | null | undefined, fromMs?: number, toMs?: number): boolean {
  if (fromMs === undefined && toMs === undefined) {
    return true;
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return false;
  }
  if (fromMs !== undefined && ts < fromMs) {
    return false;
  }
  if (toMs !== undefined && ts > toMs) {
    return false;
  }
  return true;
}

function matchesSearch(search: string, values: Array<string | null | undefined>): boolean {
  if (!search) {
    return true;
  }
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(search));
}

function numberOrUndefined(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  return num;
}
