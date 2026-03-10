import { callGateway } from "./call.js";
import type { ReadinessChecker } from "./server/readiness.js";

export type MissionControlHealthSnapshot = {
  live: boolean;
  ready: boolean;
  checkedAt: number;
  probes: {
    healthz: {
      path: "/healthz";
      ok: boolean;
      statusCode: 200;
    };
    readyz: {
      path: "/readyz";
      ok: boolean;
      statusCode: 200 | 503;
      failing: string[];
      uptimeMs: number | null;
    };
  };
};

export type MissionControlOverviewSnapshot = {
  health: MissionControlHealthSnapshot;
  kpis: {
    activeSessions: number;
    totalSessions: number;
    totalMessages: number;
    totalToolCalls: number;
    totalErrors: number;
    estimatedCostUsd: number;
  };
  providerBreakdown: Array<{ provider: string; tokens: number; cost: number }>;
  topAgents: Array<{ agentId: string; messages: number; cost: number }>;
};

export type MissionControlRunStatus = "active" | "idle" | "stalled" | "error";

export type MissionControlRun = {
  key: string;
  title: string;
  agentId: string;
  channel: string;
  updatedAt: number | null;
  status: MissionControlRunStatus;
  totalTokens: number;
  errors: number;
};

export type MissionControlRunsSnapshot = {
  live: MissionControlRun[];
  history: MissionControlRun[];
  summary: {
    active: number;
    idle: number;
    stalled: number;
    error: number;
  };
};

export type MissionControlRunDetailSnapshot = {
  run: MissionControlRun | null;
  preview: {
    status: string;
    items: Array<{
      role: string;
      text: string;
      at: number | null;
    }>;
  };
  usage: {
    totalTokens: number;
    totalCostUsd: number;
    messages: number;
    toolCalls: number;
    errors: number;
  };
};

export type MissionControlRoutingMatrixSnapshot = {
  rows: Array<{
    channel: string;
    handler: string;
    totalRuns: number;
    successRuns: number;
    failedRuns: number;
    successRate: number;
    messages: number;
  }>;
  totals: {
    totalRuns: number;
    successRuns: number;
    failedRuns: number;
  };
};

export type MissionControlIncidentRecord = {
  id: string;
  title: string;
  summary: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "investigating" | "blocked" | "resolved";
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  owner: string;
};

export type MissionControlIncidentsSnapshot = {
  incidents: MissionControlIncidentRecord[];
  blockers: MissionControlIncidentRecord[];
};

type RawSessionRow = {
  key?: string;
  label?: string;
  derivedTitle?: string;
  agentId?: string;
  channel?: string;
  updatedAt?: number | null;
  abortedLastRun?: boolean;
  totalTokens?: number;
  origin?: {
    provider?: string;
    surface?: string;
  };
};

type RawUsageSession = {
  key?: string;
  agentId?: string;
  channel?: string;
  origin?: {
    provider?: string;
    surface?: string;
  };
  usage?: {
    totalTokens?: number;
    totalCost?: number;
    messageCounts?: {
      total?: number;
      toolCalls?: number;
      errors?: number;
    };
  } | null;
};

type SessionsListPayload = {
  sessions?: RawSessionRow[];
};

type SessionsUsagePayload = {
  sessions?: RawUsageSession[];
  aggregates?: {
    byProvider?: Array<{
      provider?: string;
      totals?: { totalTokens?: number; totalCost?: number };
    }>;
    byAgent?: Array<{ agentId?: string; totals?: { totalCost?: number }; messages?: number }>;
    messages?: {
      total?: number;
      toolCalls?: number;
      errors?: number;
    };
  };
  totals?: {
    totalCost?: number;
  };
};

type SessionsPreviewPayload = {
  previews?: Array<{
    key?: string;
    status?: string;
    items?: Array<{
      role?: string;
      text?: string;
      at?: number;
    }>;
  }>;
};

type LogsTailPayload = {
  lines?: string[];
};

const ACTIVE_WINDOW_MS = 5 * 60_000;
const STALLED_WINDOW_MS = 30 * 60_000;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIntInRange(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function deriveRunStatus(run: MissionControlRun): MissionControlRunStatus {
  if (run.errors > 0) {
    return "error";
  }
  if (!run.updatedAt) {
    return "idle";
  }
  const age = Date.now() - run.updatedAt;
  if (age <= ACTIVE_WINDOW_MS) {
    return "active";
  }
  if (age >= STALLED_WINDOW_MS) {
    return "stalled";
  }
  return "idle";
}

function normalizeRun(row: RawSessionRow, index: number): MissionControlRun {
  const title = asString(row.label) ?? asString(row.derivedTitle) ?? `Session ${index + 1}`;
  const channel = asString(row.channel) ?? asString(row.origin?.provider) ?? "unknown";
  const base: MissionControlRun = {
    key: asString(row.key) ?? `unknown-${index}`,
    title,
    agentId: asString(row.agentId) ?? "unknown",
    channel,
    updatedAt: asNumber(row.updatedAt),
    status: "idle",
    totalTokens: asNumber(row.totalTokens) ?? 0,
    errors: row.abortedLastRun === true ? 1 : 0,
  };
  return {
    ...base,
    status: deriveRunStatus(base),
  };
}

function extractLogIncident(line: string): {
  severity: MissionControlIncidentRecord["severity"];
  title: string;
} | null {
  const lower = line.toLowerCase();
  if (!lower.includes("error") && !lower.includes("warn") && !lower.includes("timeout")) {
    return null;
  }

  const severity: MissionControlIncidentRecord["severity"] = lower.includes("fatal")
    ? "critical"
    : lower.includes("error")
      ? "high"
      : lower.includes("warn") || lower.includes("timeout")
        ? "medium"
        : "low";

  const title = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return { severity, title };
}

async function loadSessionsList(params: {
  limit: number;
  activeMinutes?: number;
  search?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
}): Promise<RawSessionRow[]> {
  const payload = await callGateway<SessionsListPayload>({
    method: "sessions.list",
    params: {
      limit: params.limit,
      activeMinutes: params.activeMinutes,
      includeGlobal: params.includeGlobal ?? true,
      includeUnknown: params.includeUnknown ?? true,
      search: params.search,
      includeDerivedTitles: true,
    },
  });
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

async function loadSessionsUsage(params: {
  limit: number;
  startDate?: string;
  endDate?: string;
  key?: string;
}): Promise<SessionsUsagePayload> {
  return await callGateway<SessionsUsagePayload>({
    method: "sessions.usage",
    params: {
      limit: params.limit,
      includeContextWeight: false,
      startDate: params.startDate,
      endDate: params.endDate,
      key: params.key,
    },
  });
}

function utcDateYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveOverviewReadiness(getReadiness?: ReadinessChecker): {
  ready: boolean;
  failing: string[];
  uptimeMs: number | null;
  statusCode: 200 | 503;
} {
  if (!getReadiness) {
    return {
      ready: true,
      failing: [],
      uptimeMs: null,
      statusCode: 200,
    };
  }

  try {
    const snapshot = getReadiness();
    const failing = Array.isArray(snapshot.failing)
      ? snapshot.failing
          .map((entry) => asString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : [];

    return {
      ready: snapshot.ready,
      failing,
      uptimeMs: asNumber(snapshot.uptimeMs),
      statusCode: snapshot.ready ? 200 : 503,
    };
  } catch {
    return {
      ready: false,
      failing: ["internal"],
      uptimeMs: 0,
      statusCode: 503,
    };
  }
}

export async function getMissionControlOverview(params?: {
  getReadiness?: ReadinessChecker;
}): Promise<MissionControlOverviewSnapshot> {
  const [sessions, usage] = await Promise.all([
    loadSessionsList({ limit: 300, includeGlobal: true, includeUnknown: true }),
    loadSessionsUsage({ limit: 300 }),
  ]);
  const readiness = resolveOverviewReadiness(params?.getReadiness);

  const providerBreakdown = Array.isArray(usage.aggregates?.byProvider)
    ? usage.aggregates.byProvider
        .map((entry) => ({
          provider: asString(entry.provider) ?? "unknown",
          tokens: asNumber(entry.totals?.totalTokens) ?? 0,
          cost: asNumber(entry.totals?.totalCost) ?? 0,
        }))
        .toSorted((left, right) => right.tokens - left.tokens)
    : [];

  const topAgents = Array.isArray(usage.aggregates?.byAgent)
    ? usage.aggregates.byAgent
        .map((entry) => ({
          agentId: asString(entry.agentId) ?? "unknown",
          messages: asNumber(entry.messages) ?? 0,
          cost: asNumber(entry.totals?.totalCost) ?? 0,
        }))
        .toSorted((left, right) => right.messages - left.messages)
        .slice(0, 5)
    : [];

  const activeSessions = sessions.filter((row) => {
    const updatedAt = asNumber(row.updatedAt);
    return updatedAt !== null && Date.now() - updatedAt <= ACTIVE_WINDOW_MS;
  }).length;

  const checkedAt = Date.now();

  return {
    health: {
      live: true,
      ready: readiness.ready,
      checkedAt,
      probes: {
        healthz: {
          path: "/healthz",
          ok: true,
          statusCode: 200,
        },
        readyz: {
          path: "/readyz",
          ok: readiness.ready,
          statusCode: readiness.statusCode,
          failing: readiness.failing,
          uptimeMs: readiness.uptimeMs,
        },
      },
    },
    kpis: {
      activeSessions,
      totalSessions: sessions.length,
      totalMessages: asNumber(usage.aggregates?.messages?.total) ?? 0,
      totalToolCalls: asNumber(usage.aggregates?.messages?.toolCalls) ?? 0,
      totalErrors: asNumber(usage.aggregates?.messages?.errors) ?? 0,
      estimatedCostUsd: asNumber(usage.totals?.totalCost) ?? 0,
    },
    providerBreakdown,
    topAgents,
  };
}

export async function getMissionControlRuns(params: {
  search: string;
  activeMinutes: number;
  limit: number;
}): Promise<MissionControlRunsSnapshot> {
  const rows = await loadSessionsList({
    limit: params.limit,
    activeMinutes: params.activeMinutes,
    search: params.search,
    includeGlobal: true,
    includeUnknown: true,
  });

  const normalized = rows.map((row, index) => normalizeRun(row, index));
  const history = [...normalized].toSorted(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
  const live = normalized.filter((run) => run.status === "active" || run.status === "idle");

  return {
    live,
    history,
    summary: {
      active: normalized.filter((run) => run.status === "active").length,
      idle: normalized.filter((run) => run.status === "idle").length,
      stalled: normalized.filter((run) => run.status === "stalled").length,
      error: normalized.filter((run) => run.status === "error").length,
    },
  };
}

export async function getMissionControlRunDetail(
  key: string,
): Promise<MissionControlRunDetailSnapshot> {
  const usage = await loadSessionsUsage({ key, limit: 1 });
  const usageSession =
    Array.isArray(usage.sessions) && usage.sessions.length > 0 ? usage.sessions[0] : null;

  const sessionRows = await loadSessionsList({
    limit: 300,
    search: key,
    includeGlobal: true,
    includeUnknown: true,
  });
  const matchedRow = sessionRows.find((row) => asString(row.key) === key) ?? sessionRows[0] ?? null;
  const run = matchedRow ? normalizeRun(matchedRow, 0) : null;

  const previewPayload = await callGateway<SessionsPreviewPayload>({
    method: "sessions.preview",
    params: {
      keys: [key],
      limit: 24,
      maxChars: 240,
    },
  });

  const preview = Array.isArray(previewPayload.previews) ? previewPayload.previews[0] : null;
  const items = Array.isArray(preview?.items)
    ? preview.items.map((item) => ({
        role: asString(item.role) ?? "unknown",
        text: asString(item.text) ?? "",
        at: asNumber(item.at),
      }))
    : [];

  return {
    run,
    preview: {
      status: asString(preview?.status) ?? "missing",
      items,
    },
    usage: {
      totalTokens: asNumber(usageSession?.usage?.totalTokens) ?? 0,
      totalCostUsd: asNumber(usageSession?.usage?.totalCost) ?? 0,
      messages: asNumber(usageSession?.usage?.messageCounts?.total) ?? 0,
      toolCalls: asNumber(usageSession?.usage?.messageCounts?.toolCalls) ?? 0,
      errors: asNumber(usageSession?.usage?.messageCounts?.errors) ?? 0,
    },
  };
}

export async function getMissionControlRoutingMatrix(params: {
  windowDays: number;
}): Promise<MissionControlRoutingMatrixSnapshot> {
  const end = new Date();
  const start = new Date(Date.now() - params.windowDays * 86_400_000);

  const usage = await loadSessionsUsage({
    limit: 400,
    startDate: utcDateYmd(start),
    endDate: utcDateYmd(end),
  });

  const sessions = Array.isArray(usage.sessions) ? usage.sessions : [];
  const matrix = new Map<string, MissionControlRoutingMatrixSnapshot["rows"][number]>();

  for (const session of sessions) {
    const handler = asString(session.agentId) ?? "unknown";
    const channel = asString(session.channel) ?? asString(session.origin?.provider) ?? "unknown";
    const key = `${channel}::${handler}`;
    const errors = asNumber(session.usage?.messageCounts?.errors) ?? 0;
    const messages = asNumber(session.usage?.messageCounts?.total) ?? 0;
    const row = matrix.get(key) ?? {
      channel,
      handler,
      totalRuns: 0,
      successRuns: 0,
      failedRuns: 0,
      successRate: 1,
      messages: 0,
    };

    row.totalRuns += 1;
    row.messages += messages;
    if (errors > 0) {
      row.failedRuns += 1;
    } else {
      row.successRuns += 1;
    }
    row.successRate = row.totalRuns > 0 ? row.successRuns / row.totalRuns : 1;
    matrix.set(key, row);
  }

  const rows = Array.from(matrix.values()).toSorted(
    (left, right) => right.totalRuns - left.totalRuns,
  );
  const totals = rows.reduce(
    (acc, row) => {
      acc.totalRuns += row.totalRuns;
      acc.successRuns += row.successRuns;
      acc.failedRuns += row.failedRuns;
      return acc;
    },
    {
      totalRuns: 0,
      successRuns: 0,
      failedRuns: 0,
    },
  );

  return {
    rows,
    totals,
  };
}

export async function getMissionControlIncidents(): Promise<MissionControlIncidentsSnapshot> {
  const [logs, sessions] = await Promise.all([
    callGateway<LogsTailPayload>({
      method: "logs.tail",
      params: {
        limit: 300,
        maxBytes: 512_000,
      },
    }),
    loadSessionsList({
      limit: 250,
      includeUnknown: true,
      includeGlobal: true,
    }),
  ]);

  const lines = Array.isArray(logs.lines) ? logs.lines : [];
  const incidents = new Map<string, MissionControlIncidentRecord>();

  for (const line of lines) {
    const extracted = extractLogIncident(line);
    if (!extracted) {
      continue;
    }

    const id = `log-${extracted.title.slice(0, 48)}`;
    const existing = incidents.get(id);
    if (!existing) {
      incidents.set(id, {
        id,
        title: extracted.title,
        summary: "Derived from logs.tail until dedicated incident APIs land.",
        severity: extracted.severity,
        status: extracted.severity === "critical" ? "blocked" : "open",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        count: 1,
        owner: "@tony",
      });
      continue;
    }

    existing.count += 1;
    existing.lastSeenAt = Date.now();
  }

  const rows = Array.from(incidents.values()).toSorted((left, right) => {
    const weight: Record<MissionControlIncidentRecord["severity"], number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    const severityDelta = weight[right.severity] - weight[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return right.count - left.count;
  });

  const blockersFromRuns = sessions
    .filter((row) => row.abortedLastRun === true)
    .slice(0, 8)
    .map((row, index) => ({
      id: `abort-${asString(row.key) ?? index}`,
      title: asString(row.label) ?? asString(row.derivedTitle) ?? "Aborted run",
      summary: "Latest run ended with an abort flag.",
      severity: "high" as const,
      status: "blocked" as const,
      firstSeenAt: asNumber(row.updatedAt) ?? Date.now(),
      lastSeenAt: asNumber(row.updatedAt) ?? Date.now(),
      count: 1,
      owner: asString(row.agentId) ?? "unknown",
    }));

  const blockers = [
    ...rows.filter((incident) => incident.status === "blocked"),
    ...blockersFromRuns,
  ];

  return {
    incidents: rows,
    blockers,
  };
}

export function parseMissionControlRunsQuery(searchParams: URLSearchParams): {
  search: string;
  activeMinutes: number;
  limit: number;
} {
  return {
    search: searchParams.get("search")?.trim() ?? "",
    activeMinutes: toIntInRange(searchParams.get("activeMinutes"), 60, 1, 60 * 24 * 14),
    limit: toIntInRange(searchParams.get("limit"), 100, 1, 500),
  };
}

export function parseMissionControlRoutingQuery(searchParams: URLSearchParams): {
  windowDays: number;
} {
  return {
    windowDays: toIntInRange(searchParams.get("windowDays"), 7, 1, 90),
  };
}
