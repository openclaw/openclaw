import { resolveUserTimezone } from "../agents/date-time.js";
import type { CronConfig } from "../config/types.cron.js";
import { normalizeAgentId } from "../routing/session-key.js";

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

export type MaintenancePhase = "normal" | "maintenance";

export type MaintenanceWindowResolved = {
  start: string;
  end: string;
  timezone: string;
};

export type MaintenanceExecutionDecision = {
  enabled: boolean;
  phase: MaintenancePhase;
  allowed: boolean;
  isMaintenanceAgent: boolean;
  maintenanceAgents: string[];
  window: MaintenanceWindowResolved | null;
};

function parseTimeMinutes(params: { allow24: boolean; raw?: string }): number | null {
  const raw = params.raw?.trim();
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!params.allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveActiveHoursTimezone(userTimezone?: string, raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user") {
    return resolveUserTimezone(userTimezone);
  }
  if (trimmed === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host?.trim() || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return resolveUserTimezone(userTimezone);
  }
}

function resolveMinutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function resolveMaintenanceWindow(
  cronConfig?: CronConfig,
  userTimezone?: string,
): {
  enabled: boolean;
  startMin: number | null;
  endMin: number | null;
  timezone: string;
  window: MaintenanceWindowResolved | null;
} {
  const maintenance = cronConfig?.maintenance;
  const enabled = maintenance?.enabled === true;
  const start = maintenance?.window?.start?.trim();
  const end = maintenance?.window?.end?.trim();
  const timezone = resolveActiveHoursTimezone(userTimezone, maintenance?.window?.timezone);
  const startMin = parseTimeMinutes({ allow24: false, raw: start });
  const endMin = parseTimeMinutes({ allow24: true, raw: end });
  const validWindow =
    typeof start === "string" &&
    typeof end === "string" &&
    startMin !== null &&
    endMin !== null &&
    startMin !== endMin;
  return {
    enabled,
    startMin,
    endMin,
    timezone,
    window:
      validWindow && start && end
        ? {
            start,
            end,
            timezone,
          }
        : null,
  };
}

function isWithinMaintenanceWindow(params: {
  nowMs: number;
  startMin: number;
  endMin: number;
  timezone: string;
}): boolean {
  const currentMin = resolveMinutesInTimeZone(params.nowMs, params.timezone);
  if (currentMin === null) {
    return false;
  }
  if (params.endMin > params.startMin) {
    return currentMin >= params.startMin && currentMin < params.endMin;
  }
  return currentMin >= params.startMin || currentMin < params.endMin;
}

export function resolveMaintenanceAgentAllowlist(cronConfig?: CronConfig): string[] {
  const normalized = new Set<string>();
  for (const raw of cronConfig?.maintenance?.maintenanceAgents ?? []) {
    if (!raw.trim()) {
      continue;
    }
    const agentId = normalizeAgentId(raw);
    if (agentId) {
      normalized.add(agentId);
    }
  }
  return [...normalized];
}

export function resolveMaintenancePhase(params: {
  cronConfig?: CronConfig;
  userTimezone?: string;
  nowMs?: number;
}): MaintenancePhase {
  const nowMs = params.nowMs ?? Date.now();
  const window = resolveMaintenanceWindow(params.cronConfig, params.userTimezone);
  if (!window.enabled || window.startMin === null || window.endMin === null) {
    return "normal";
  }
  return isWithinMaintenanceWindow({
    nowMs,
    startMin: window.startMin,
    endMin: window.endMin,
    timezone: window.timezone,
  })
    ? "maintenance"
    : "normal";
}

export function resolveMaintenanceExecutionDecision(params: {
  cronConfig?: CronConfig;
  userTimezone?: string;
  agentId?: string;
  nowMs?: number;
}): MaintenanceExecutionDecision {
  const nowMs = params.nowMs ?? Date.now();
  const maintenanceAgents = resolveMaintenanceAgentAllowlist(params.cronConfig);
  const window = resolveMaintenanceWindow(params.cronConfig, params.userTimezone);
  const phase =
    window.enabled &&
    window.startMin !== null &&
    window.endMin !== null &&
    isWithinMaintenanceWindow({
      nowMs,
      startMin: window.startMin,
      endMin: window.endMin,
      timezone: window.timezone,
    })
      ? "maintenance"
      : "normal";
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const isMaintenanceAgent = normalizedAgentId
    ? maintenanceAgents.includes(normalizedAgentId)
    : false;
  const enabled = window.enabled && window.window !== null;
  const allowed = enabled
    ? phase === "maintenance"
      ? isMaintenanceAgent
      : !isMaintenanceAgent
    : true;

  return {
    enabled,
    phase,
    allowed,
    isMaintenanceAgent,
    maintenanceAgents,
    window: window.window,
  };
}
