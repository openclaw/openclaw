import { asNullableRecord as recordOrNull } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { sessionMatchesArchivedFilter, type SessionArchivedFilter } from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import { isShallowEqualSessionRow } from "./session-row-equality.ts";
import {
  preserveOmittedThinkingMetadata,
  stripThinkingMetadata,
  thinkingMetadataFields,
  thinkingMetadataIdentityMatches,
  type ThinkingMetadataCarrier,
} from "./session-thinking-metadata.ts";

export type SessionReconcileOptions = {
  resultAgentId?: string | null;
  selectedGlobalAgentId?: string | null;
  archivedFilter?: SessionArchivedFilter;
};

export type SessionChangedRowProjection = (
  row: GatewaySessionRow,
  previous: GatewaySessionRow,
  fields: readonly string[],
) => GatewaySessionRow;

export type SessionChangedRowResult = {
  applied: boolean;
  key?: string;
  agentId?: string | null;
  runId?: string | null;
  clientRunId?: string | null;
  hasActiveRun?: boolean | null;
  status?: SessionRunStatus | null;
  isChatTurn?: boolean;
  row?: GatewaySessionRow;
  /** Accepted event facts remain available when a list filter removes the row. */
  admittedRow?: GatewaySessionRow;
  deletedKey?: string;
  /** A held row reached snapshot reduction; list adapters still own publication. */
  reconciled?: true;
  eventTs?: number;
  ownershipChanged?: boolean;
  disposition?: SessionRowReconcileResult["disposition"];
};

type SessionChangedEventInfo = {
  key: string;
  reason: string | null;
  sessionId?: string;
  updatedAt: number | null;
  hasPermissionMode: boolean;
  thinkingLevel?: string | null;
  agentId: string | null;
  runId: string | null;
  clientRunId: string | null;
  hasActiveRun: boolean | null;
  activeRunIds?: string[] | null;
  status: SessionRunStatus | null;
  archived: boolean | null;
  isChatTurn: boolean;
};

function sanitizeSessionRow(row: GatewaySessionRow): GatewaySessionRow {
  const next = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (
      value === undefined ||
      (key === "totalTokensFresh" && value === false && row.totalTokens === undefined)
    ) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
}

export function isPersistedSessionRow(row: GatewaySessionRow): boolean {
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  return Boolean(sessionId || typeof row.updatedAt === "number");
}

export function preserveRosterPresentationMetadata(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): GatewaySessionRow {
  if (
    !existing ||
    !incoming.sessionId ||
    incoming.sessionId !== existing.sessionId ||
    (incoming.derivedTitle !== undefined && incoming.lastMessagePreview !== undefined)
  ) {
    return incoming;
  }
  const incomingAgentId = sessionAgentId(incoming, null);
  const existingAgentId = sessionAgentId(existing, null);
  if (incomingAgentId && existingAgentId && incomingAgentId !== existingAgentId) {
    return incoming;
  }
  return {
    ...incoming,
    ...(incoming.derivedTitle === undefined && existing.derivedTitle !== undefined
      ? { derivedTitle: existing.derivedTitle }
      : {}),
    ...(incoming.lastMessagePreview === undefined && existing.lastMessagePreview !== undefined
      ? { lastMessagePreview: existing.lastMessagePreview }
      : {}),
  };
}

function isOlderSessionSnapshot(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  return (
    typeof incoming.updatedAt === "number" &&
    typeof existing?.updatedAt === "number" &&
    incoming.updatedAt < existing.updatedAt
  );
}

function isStaleForActiveSession(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  if (!existing || !isSessionRunActive(existing) || isSessionRunActive(incoming)) {
    return false;
  }
  const incomingUpdatedAt = incoming.updatedAt ?? 0;
  return (
    (existing.updatedAt ?? 0) >= incomingUpdatedAt ||
    (typeof existing.startedAt === "number" && existing.startedAt >= incomingUpdatedAt)
  );
}

export function matchesExistingSession(
  existing: GatewaySessionRow,
  incomingKey: string,
  selectedGlobalAgentId: string | null,
): boolean {
  const existingAgentId = sessionAgentId(existing, null);
  const incomingAgentId = parseAgentSessionKey(incomingKey)?.agentId ?? selectedGlobalAgentId;
  if (
    existingAgentId &&
    incomingAgentId?.trim() &&
    existingAgentId !== normalizeAgentId(incomingAgentId)
  ) {
    return false;
  }
  if (areUiSessionKeysEquivalent(existing.key, incomingKey)) {
    return true;
  }
  if (!isUiGlobalSessionKey(incomingKey) || existing.kind !== "global") {
    return false;
  }
  const parsed = parseAgentSessionKey(existing.key);
  return (
    parsed?.agentId !== undefined &&
    normalizeAgentId(parsed.agentId) === normalizeAgentId(selectedGlobalAgentId ?? "")
  );
}

function sessionAgentId(
  row: GatewaySessionRow,
  selectedGlobalAgentId: string | null,
): string | null {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  if (row.agentId?.trim()) {
    return normalizeAgentId(row.agentId);
  }
  if (row.kind === "global" && selectedGlobalAgentId?.trim()) {
    return normalizeAgentId(selectedGlobalAgentId);
  }
  return null;
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function sessionRunStatus(value: unknown): SessionRunStatus | null {
  return value === "running" ||
    value === "queued" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

type ParsedSessionChangedEvent = readonly [
  info: SessionChangedEventInfo,
  event: Record<string, unknown>,
  source: Record<string, unknown>,
  reason: string | null,
];

function parseSessionChangedEvent(payload: unknown): ParsedSessionChangedEvent | null {
  const event = recordOrNull(payload);
  if (!event) {
    return null;
  }
  const source = recordOrNull(event.session) ?? event;
  const key =
    stringValue(recordValue(source, "key")) ?? stringValue(recordValue(event, "sessionKey"));
  if (!key) {
    return null;
  }
  const reason =
    stringValue(recordValue(event, "reason")) ?? stringValue(recordValue(source, "reason")) ?? null;
  const phase =
    stringValue(recordValue(event, "phase")) ?? stringValue(recordValue(source, "phase"));
  const sourceHasActiveRun = recordValue(source, "hasActiveRun");
  const hasActiveRun =
    typeof sourceHasActiveRun === "boolean"
      ? sourceHasActiveRun
      : recordValue(event, "hasActiveRun");
  const archived = recordValue(source, "archived");
  const updatedAt = recordValue(source, "updatedAt");
  const thinkingLevel = recordValue(source, "thinkingLevel");
  const activeRunIds = Object.hasOwn(source, "activeRunIds")
    ? recordValue(source, "activeRunIds")
    : recordValue(event, "activeRunIds");
  return [
    {
      key,
      reason,
      sessionId: stringValue(recordValue(source, "sessionId")),
      updatedAt: typeof updatedAt === "number" ? updatedAt : null,
      hasPermissionMode: Object.hasOwn(source, "permissionMode"),
      thinkingLevel:
        typeof thinkingLevel === "string"
          ? thinkingLevel
          : thinkingLevel === null
            ? null
            : undefined,
      agentId: stringValue(recordValue(event, "agentId")) ?? null,
      runId:
        stringValue(recordValue(event, "runId")) ??
        stringValue(recordValue(source, "runId")) ??
        null,
      clientRunId:
        stringValue(recordValue(event, "clientRunId")) ??
        stringValue(recordValue(source, "clientRunId")) ??
        null,
      hasActiveRun: typeof hasActiveRun === "boolean" ? hasActiveRun : null,
      activeRunIds:
        activeRunIds === null ||
        (Array.isArray(activeRunIds) && activeRunIds.every((id) => typeof id === "string"))
          ? activeRunIds
          : undefined,
      status:
        sessionRunStatus(recordValue(source, "status")) ??
        sessionRunStatus(recordValue(event, "status")),
      archived: typeof archived === "boolean" ? archived : null,
      isChatTurn:
        phase === "start" ||
        phase === "message" ||
        phase === "end" ||
        phase === "error" ||
        reason === "send" ||
        reason === "steer",
    },
    event,
    source,
    reason,
  ];
}

export function readSessionChangedEvent(payload: unknown): SessionChangedEventInfo | null {
  return parseSessionChangedEvent(payload)?.[0] ?? null;
}

// Null source confirms inheritance; omission on a lifecycle event preserves selection.
const NULLABLE_SESSION_ROW_FIELDS = new Set<string>([
  "updatedAt",
  "activeLeafEntryId",
  "modelOverrideSource",
]);

export type SessionRowObservation = {
  observe?: (row: GatewaySessionRow) => void;
  isProvisional?: (row: GatewaySessionRow) => boolean;
  project?: (row: GatewaySessionRow, donor?: GatewaySessionRow) => GatewaySessionRow;
};

type SessionRowReconcileOptions = SessionReconcileOptions & {
  preserveExisting?: boolean;
};

type RejectedRowDisposition =
  | "invalid"
  | "outside-scope"
  | "preserved"
  | "older"
  | "unpersisted"
  | "stale-active";

type SessionRowReconcileResult =
  | {
      disposition: RejectedRowDisposition;
      row: GatewaySessionRow | undefined;
      admittedRow?: undefined;
      confirmRead: false;
    }
  | {
      disposition: "unchanged" | "accepted";
      row: GatewaySessionRow | undefined;
      admittedRow: GatewaySessionRow;
      confirmRead: boolean;
    };

export function isSessionRowOutsideResultScope(
  row: GatewaySessionRow,
  options: SessionReconcileOptions,
): boolean {
  const resultAgentId = options.resultAgentId?.trim()
    ? normalizeAgentId(options.resultAgentId)
    : null;
  const incomingAgentId = sessionAgentId(row, options.selectedGlobalAgentId ?? null);
  return resultAgentId !== null && incomingAgentId !== null && incomingAgentId !== resultAgentId;
}

/** Reduces one matched row; its caller owns the roster and request/deletion fences. */
export function reconcileSessionRow(
  incoming: GatewaySessionRow | undefined,
  previous: GatewaySessionRow | undefined,
  options: SessionRowReconcileOptions = {},
  observation?: SessionRowObservation,
): SessionRowReconcileResult {
  const reject = (disposition: RejectedRowDisposition): SessionRowReconcileResult => ({
    disposition,
    row: previous,
    confirmRead: false,
  });
  if (!incoming?.key) {
    return reject("invalid");
  }
  const session = sanitizeSessionRow(incoming);
  if (isSessionRowOutsideResultScope(session, options)) {
    return reject("outside-scope");
  }
  // Provisional presentation cannot donate metadata, but still fences old/run snapshots.
  const existing = previous && observation?.isProvisional?.(previous) ? undefined : previous;
  if (options.preserveExisting && previous) {
    return reject("preserved");
  }
  if (isOlderSessionSnapshot(session, previous)) {
    return reject("older");
  }
  if (!existing && !isPersistedSessionRow(session)) {
    return reject("unpersisted");
  }
  const visibleKey = previous?.key ?? session.key;
  let admittedRow = preserveRosterPresentationMetadata(
    preserveOmittedThinkingMetadata(
      visibleKey === session.key ? session : { ...session, key: visibleKey },
      existing,
    ),
    existing,
  );
  if (isStaleForActiveSession(admittedRow, previous)) {
    return reject("stale-active");
  }
  admittedRow = observation?.project?.(admittedRow, existing) ?? admittedRow;
  const retained = sessionMatchesArchivedFilter(admittedRow, options.archivedFilter ?? "active");
  if (existing && isShallowEqualSessionRow(admittedRow, existing) && retained) {
    // Confirm only an identical full input; copied omitted fields remain donor facts.
    const confirmRead = isShallowEqualSessionRow(session, existing);
    if (confirmRead) {
      observation?.observe?.(existing);
    }
    return {
      disposition: "unchanged",
      row: existing,
      admittedRow: confirmRead ? existing : admittedRow,
      confirmRead,
    };
  }
  const row = retained ? admittedRow : undefined;
  if (row) {
    observation?.observe?.(row);
  }
  return { disposition: "accepted", row, admittedRow, confirmRead: row !== undefined };
}

/** Applies event facts to an existing member without manufacturing list membership. */
export function reconcileSessionChangedRow(
  existing: GatewaySessionRow | undefined,
  payload: unknown,
  options: SessionReconcileOptions = {},
  project?: SessionChangedRowProjection,
): SessionChangedRowResult {
  const parsed = parseSessionChangedEvent(payload);
  if (!parsed) {
    return { applied: false, row: existing };
  }
  const [info, event, source, reason] = parsed;
  const { key } = info;
  const {
    agentId: _agentId,
    clientRunId: _clientRunId,
    compacted: _compacted,
    key: _key,
    phase: _phase,
    reason: _reason,
    runId: _runId,
    session: _session,
    sessionKey: _sessionKey,
    ts: _ts,
    ...rowFields
  } = source;
  if (
    !info.agentId &&
    (isUiGlobalSessionKey(key) || (!parseAgentSessionKey(key) && !Object.keys(rowFields).length))
  ) {
    return { applied: false, key, agentId: null, row: existing };
  }
  if (reason === "delete" && !info.sessionId) {
    return { applied: false, key, agentId: info.agentId, row: existing };
  }
  if (reason === "delete") {
    if (existing && existing.sessionId !== info.sessionId) {
      return { applied: false, key, agentId: info.agentId, row: existing };
    }
    return { applied: true, key, agentId: info.agentId, deletedKey: existing?.key ?? key };
  }
  // The Gateway folds cron/spawn-child into direct before projection.
  const kind =
    rowFields.kind === "direct" ||
    rowFields.kind === "group" ||
    rowFields.kind === "global" ||
    rowFields.kind === "unknown"
      ? rowFields.kind
      : existing?.kind;
  const updatedAt =
    typeof rowFields.updatedAt === "number" ? rowFields.updatedAt : existing?.updatedAt;
  const sessionId = stringValue(rowFields.sessionId) ?? existing?.sessionId;
  if (!kind || (!existing && sessionId === undefined && typeof updatedAt !== "number")) {
    return { applied: false, row: existing };
  }
  const eventResult = {
    applied: true as const,
    key,
    agentId: info.agentId,
    runId: info.runId,
    clientRunId: info.clientRunId,
    hasActiveRun: info.hasActiveRun,
    status: info.status,
    isChatTurn: info.isChatTurn,
  };
  // A target without a row can be invalidated, but an event cannot create its snapshot.
  if (!existing) {
    return eventResult;
  }
  const incomingRuntime = recordOrNull(rowFields.agentRuntime);
  const incomingThinkingIdentity: ThinkingMetadataCarrier = {
    modelProvider: stringValue(rowFields.modelProvider),
    model: stringValue(rowFields.model),
    ...(incomingRuntime ? { agentRuntime: { id: stringValue(incomingRuntime.id) ?? "" } } : {}),
  };
  const existingFields = !thinkingMetadataIdentityMatches(incomingThinkingIdentity, existing)
    ? stripThinkingMetadata(existing)
    : existing;
  const offered = {
    ...existingFields,
    ...rowFields,
    key: existing.key,
    kind,
    updatedAt: updatedAt ?? null,
    ...(sessionId ? { sessionId } : {}),
  };
  // Optional wire fields use null as a tombstone; the explicit nullable fields keep null.
  for (const [field, value] of Object.entries(rowFields)) {
    if (value === null && !NULLABLE_SESSION_ROW_FIELDS.has(field)) {
      Reflect.deleteProperty(offered, field);
    }
  }
  const fields = [
    ...Object.keys(rowFields).filter((field) => rowFields[field] !== undefined),
    ...(existingFields !== existing ? thinkingMetadataFields : []),
  ];
  const reduced = reconcileSessionRow(
    offered,
    existing,
    {
      ...options,
      selectedGlobalAgentId: info.agentId ?? options.selectedGlobalAgentId ?? null,
    },
    project ? { project: (row) => project(row, existing, fields) } : undefined,
  );
  const previousOwner = existing.owner?.actor;
  const nextOwner = reduced.admittedRow?.owner?.actor;
  const ownershipChanged =
    Boolean(reduced.admittedRow) &&
    (Object.hasOwn(rowFields, "owner") || Object.hasOwn(rowFields, "createdActor")) &&
    (previousOwner?.type !== nextOwner?.type ||
      previousOwner?.id !== nextOwner?.id ||
      previousOwner?.label !== nextOwner?.label ||
      existing.owner?.assignedAt !== reduced.admittedRow?.owner?.assignedAt);
  return {
    ...eventResult,
    row: reduced.row,
    admittedRow: reduced.admittedRow,
    reconciled: true,
    disposition: reduced.disposition,
    ...(typeof event.ts === "number" && Number.isFinite(event.ts) ? { eventTs: event.ts } : {}),
    ownershipChanged,
  };
}
