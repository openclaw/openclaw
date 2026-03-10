type MissionControlAcpxSessionStatus = "active" | "idle" | "error" | "closed";

export type MissionControlAcpxSessionSummary = {
  sessionId: string;
  agent: string;
  scope: {
    repo: string | null;
    cwd: string | null;
  };
  lastActivity: number;
  status: MissionControlAcpxSessionStatus;
};

export type MissionControlAcpxSessionsSnapshot = {
  sessions: MissionControlAcpxSessionSummary[];
  summary: {
    totalTracked: number;
    active: number;
    idle: number;
    error: number;
    closed: number;
  };
  generatedAt: number;
  storage: "memory";
};

export type MissionControlAcpxIngestResult = {
  accepted: number;
  rejected: number;
  sessionsUpdated: number;
  storage: "memory";
  errors: Array<{
    index: number;
    reason: string;
  }>;
};

type MissionControlAcpxEvent = {
  sessionId: string;
  agent: string;
  repo: string | null;
  cwd: string | null;
  status: MissionControlAcpxSessionStatus;
  activityAt: number;
};

type MissionControlAcpxSessionState = {
  sessionId: string;
  agent: string;
  scope: {
    repo: string | null;
    cwd: string | null;
  };
  lastActivity: number;
  status: MissionControlAcpxSessionStatus;
};

type ParseEventsResult = {
  events: MissionControlAcpxEvent[];
  errors: Array<{
    index: number;
    reason: string;
  }>;
};

const ACTIVE_SESSION_STATUSES: ReadonlySet<MissionControlAcpxSessionStatus> = new Set([
  "active",
  "idle",
  "error",
]);

const sessionStateById = new Map<string, MissionControlAcpxSessionState>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getRecordPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = record;
  for (const key of path) {
    const next = asRecord(cursor);
    if (!next) {
      return undefined;
    }
    cursor = next[key];
  }
  return cursor;
}

function firstStringPath(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): string | null {
  for (const path of paths) {
    const value = asString(getRecordPath(record, path));
    if (value) {
      return value;
    }
  }
  return null;
}

function firstUnknownPath(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): unknown {
  for (const path of paths) {
    const value = getRecordPath(record, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return parseTimestamp(numeric, fallback);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeStatus(raw: string | null): MissionControlAcpxSessionStatus {
  if (!raw) {
    return "active";
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return "active";
  }
  if (
    normalized.includes("closed") ||
    normalized.includes("complete") ||
    normalized.includes("ended") ||
    normalized.includes("done")
  ) {
    return "closed";
  }
  if (normalized.includes("error") || normalized.includes("fail") || normalized.includes("abort")) {
    return "error";
  }
  if (normalized.includes("idle") || normalized.includes("wait")) {
    return "idle";
  }
  return "active";
}

function normalizeEventCandidate(
  candidate: unknown,
  index: number,
  receivedAt: number,
):
  | {
      ok: true;
      value: MissionControlAcpxEvent;
    }
  | {
      ok: false;
      reason: string;
      index: number;
    } {
  const record = asRecord(candidate);
  if (!record) {
    return {
      ok: false,
      index,
      reason: "event must be a JSON object",
    };
  }

  const sessionId = firstStringPath(record, [
    ["sessionId"],
    ["session_id"],
    ["acpxSessionId"],
    ["acpSessionId"],
    ["session", "id"],
    ["session", "sessionId"],
    ["identity", "acpxSessionId"],
    ["identity", "sessionId"],
  ]);

  if (!sessionId) {
    return {
      ok: false,
      index,
      reason: "sessionId is required",
    };
  }

  const agent =
    firstStringPath(record, [
      ["agent"],
      ["agentId"],
      ["session", "agent"],
      ["session", "agentId"],
      ["identity", "agent"],
      ["identity", "agentId"],
    ]) ?? "unknown";

  const repo = firstStringPath(record, [
    ["repo"],
    ["repository"],
    ["scope", "repo"],
    ["scope", "repository"],
    ["workspace", "repo"],
    ["meta", "repo"],
  ]);

  const cwd = firstStringPath(record, [
    ["cwd"],
    ["scope", "cwd"],
    ["workspace", "cwd"],
    ["meta", "cwd"],
  ]);

  const status = normalizeStatus(
    firstStringPath(record, [["status"], ["state"], ["session", "status"], ["session", "state"]]),
  );

  const activityAt = parseTimestamp(
    firstUnknownPath(record, [
      ["lastActivity"],
      ["lastActivityAt"],
      ["timestamp"],
      ["time"],
      ["at"],
      ["ts"],
      ["updatedAt"],
      ["createdAt"],
    ]),
    receivedAt,
  );

  return {
    ok: true,
    value: {
      sessionId,
      agent,
      repo,
      cwd,
      status,
      activityAt,
    },
  };
}

function parseJsonEventsPayload(payload: unknown, receivedAt: number): ParseEventsResult {
  const envelope = asRecord(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope?.events)
      ? envelope.events
      : envelope && envelope.event !== undefined
        ? [envelope.event]
        : envelope
          ? [envelope]
          : [];

  const events: MissionControlAcpxEvent[] = [];
  const errors: ParseEventsResult["errors"] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const normalized = normalizeEventCandidate(candidates[i], i, receivedAt);
    if (!normalized.ok) {
      errors.push({
        index: normalized.index,
        reason: normalized.reason,
      });
      continue;
    }
    events.push(normalized.value);
  }

  return { events, errors };
}

function parseNdjsonEvents(rawBody: string, receivedAt: number): ParseEventsResult {
  const lines = rawBody
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: MissionControlAcpxEvent[] = [];
  const errors: ParseEventsResult["errors"] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      errors.push({
        index: i,
        reason: "invalid NDJSON line",
      });
      continue;
    }

    const normalized = normalizeEventCandidate(parsed, i, receivedAt);
    if (!normalized.ok) {
      errors.push({
        index: normalized.index,
        reason: normalized.reason,
      });
      continue;
    }
    events.push(normalized.value);
  }

  return { events, errors };
}

function shouldParseNdjson(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.toLowerCase().includes("ndjson");
}

function parseIngestPayload(params: {
  rawBody: string;
  contentType: string | undefined;
  receivedAt: number;
}): ParseEventsResult {
  const trimmed = params.rawBody.trim();
  if (!trimmed) {
    return {
      events: [],
      errors: [{ index: 0, reason: "empty payload" }],
    };
  }

  if (shouldParseNdjson(params.contentType)) {
    return parseNdjsonEvents(trimmed, params.receivedAt);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parseJsonEventsPayload(parsed, params.receivedAt);
  } catch {
    if (trimmed.includes("\n")) {
      return parseNdjsonEvents(trimmed, params.receivedAt);
    }
    return {
      events: [],
      errors: [{ index: 0, reason: "invalid JSON payload" }],
    };
  }
}

function upsertSessions(events: readonly MissionControlAcpxEvent[]): { sessionsUpdated: number } {
  const touched = new Set<string>();

  for (const event of events) {
    touched.add(event.sessionId);
    const current = sessionStateById.get(event.sessionId);

    if (!current) {
      sessionStateById.set(event.sessionId, {
        sessionId: event.sessionId,
        agent: event.agent,
        scope: {
          repo: event.repo,
          cwd: event.cwd,
        },
        lastActivity: event.activityAt,
        status: event.status,
      });
      continue;
    }

    const nextLastActivity = Math.max(current.lastActivity, event.activityAt);
    const shouldApplyEventStatus = event.activityAt >= current.lastActivity;

    sessionStateById.set(event.sessionId, {
      sessionId: event.sessionId,
      agent: event.agent || current.agent,
      scope: {
        repo: event.repo ?? current.scope.repo,
        cwd: event.cwd ?? current.scope.cwd,
      },
      lastActivity: nextLastActivity,
      status: shouldApplyEventStatus ? event.status : current.status,
    });
  }

  return {
    sessionsUpdated: touched.size,
  };
}

export function ingestMissionControlAcpxEvents(params: {
  rawBody: string;
  contentType: string | undefined;
  receivedAt?: number;
}): MissionControlAcpxIngestResult {
  const receivedAt =
    typeof params.receivedAt === "number" && Number.isFinite(params.receivedAt)
      ? Math.round(params.receivedAt)
      : Date.now();

  const parsed = parseIngestPayload({
    rawBody: params.rawBody,
    contentType: params.contentType,
    receivedAt,
  });

  const update = upsertSessions(parsed.events);

  return {
    accepted: parsed.events.length,
    rejected: parsed.errors.length,
    sessionsUpdated: update.sessionsUpdated,
    storage: "memory",
    errors: parsed.errors,
  };
}

function countByStatus(
  sessions: readonly MissionControlAcpxSessionState[],
): MissionControlAcpxSessionsSnapshot["summary"] {
  return sessions.reduce(
    (acc, session) => {
      if (session.status === "active") {
        acc.active += 1;
      } else if (session.status === "idle") {
        acc.idle += 1;
      } else if (session.status === "error") {
        acc.error += 1;
      } else {
        acc.closed += 1;
      }
      return acc;
    },
    {
      totalTracked: sessions.length,
      active: 0,
      idle: 0,
      error: 0,
      closed: 0,
    },
  );
}

export function getMissionControlAcpxSessionsSnapshot(): MissionControlAcpxSessionsSnapshot {
  const sessions = Array.from(sessionStateById.values()).toSorted(
    (left, right) => right.lastActivity - left.lastActivity,
  );

  return {
    sessions: sessions
      .filter((session) => ACTIVE_SESSION_STATUSES.has(session.status))
      .map((session) => ({
        sessionId: session.sessionId,
        agent: session.agent,
        scope: {
          repo: session.scope.repo,
          cwd: session.scope.cwd,
        },
        lastActivity: session.lastActivity,
        status: session.status,
      })),
    summary: countByStatus(sessions),
    generatedAt: Date.now(),
    // In-memory MVP: process-local only, resets on gateway restart.
    storage: "memory",
  };
}

export function resetMissionControlAcpxStoreForTests(): void {
  sessionStateById.clear();
}
