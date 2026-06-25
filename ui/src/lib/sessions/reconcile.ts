import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { isSessionRunActive } from "../session-run-state.ts";

export type SessionReconcileOptions = {
  resultAgentId?: string | null;
  selectedGlobalAgentId?: string | null;
  showArchived?: boolean;
};

type ThinkingMetadataCarrier = {
  modelProvider?: string | null;
  model?: string | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

function sanitizeSessionRow(row: GatewaySessionRow): GatewaySessionRow {
  const next: Partial<GatewaySessionRow> = {};
  for (const [key, value] of Object.entries(row) as Array<[keyof GatewaySessionRow, unknown]>) {
    if (value === undefined) {
      continue;
    }
    if (key === "totalTokensFresh" && value === false && row.totalTokens === undefined) {
      continue;
    }
    next[key] = value as never;
  }
  return next as GatewaySessionRow;
}

function isPersistedSessionRow(row: GatewaySessionRow): boolean {
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  return Boolean(sessionId || typeof row.updatedAt === "number");
}

function thinkingMetadataModelMatches(
  incoming: ThinkingMetadataCarrier,
  existing: ThinkingMetadataCarrier,
): boolean {
  return !(
    (incoming.modelProvider &&
      existing.modelProvider &&
      incoming.modelProvider !== existing.modelProvider) ||
    (incoming.model && existing.model && incoming.model !== existing.model)
  );
}

function preserveRicherThinkingMetadata<T extends ThinkingMetadataCarrier>(
  incoming: T,
  existing: ThinkingMetadataCarrier | undefined,
): T {
  if (existing && !thinkingMetadataModelMatches(incoming, existing)) {
    return incoming;
  }
  const existingLevels = existing?.thinkingLevels;
  if (!existingLevels?.length || (incoming.thinkingLevels?.length ?? 0) >= existingLevels.length) {
    return incoming;
  }
  return {
    ...incoming,
    thinkingLevels: existingLevels,
    ...(existing?.thinkingOptions ? { thinkingOptions: existing.thinkingOptions } : {}),
    ...(incoming.thinkingDefault === undefined && existing.thinkingDefault !== undefined
      ? { thinkingDefault: existing.thinkingDefault }
      : {}),
  };
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

function matchesExistingSession(
  existing: GatewaySessionRow,
  incoming: GatewaySessionRow,
  selectedGlobalAgentId: string | null,
): boolean {
  if (areUiSessionKeysEquivalent(existing.key, incoming.key)) {
    return true;
  }
  if (!isUiGlobalSessionKey(incoming.key) || existing.kind !== "global") {
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
  if (row.kind === "global" && selectedGlobalAgentId?.trim()) {
    return normalizeAgentId(selectedGlobalAgentId);
  }
  return null;
}

function compareSessionRowsByUpdatedAt(a: GatewaySessionRow, b: GatewaySessionRow): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export function reconcileSessionHistory(
  result: SessionsListResult | null,
  row: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  options: SessionReconcileOptions = {},
): SessionsListResult | null {
  if (!row?.key) {
    return result;
  }
  const session = sanitizeSessionRow(row);
  const showArchived = options.showArchived === true;
  const selectedGlobalAgentId = options.selectedGlobalAgentId ?? null;
  const resultAgentId = options.resultAgentId?.trim()
    ? normalizeAgentId(options.resultAgentId)
    : null;
  const incomingAgentId = sessionAgentId(session, selectedGlobalAgentId);
  const isOutsideResultScope =
    resultAgentId !== null && incomingAgentId !== null && incomingAgentId !== resultAgentId;
  if (!result) {
    if ((!isPersistedSessionRow(session) || isOutsideResultScope) && !defaults) {
      return null;
    }
    const sessions =
      isPersistedSessionRow(session) &&
      !isOutsideResultScope &&
      (showArchived || session.archived !== true)
        ? [session]
        : [];
    return {
      ts: Date.now(),
      path: "",
      count: sessions.length,
      defaults: defaults ?? {
        modelProvider: null,
        model: null,
        contextTokens: null,
      },
      sessions,
    };
  }

  const existing = result.sessions.find((candidate) =>
    matchesExistingSession(candidate, session, selectedGlobalAgentId),
  );
  const nextDefaults = defaults
    ? preserveRicherThinkingMetadata(defaults, result.defaults)
    : result.defaults;
  if (isOutsideResultScope || (!existing && !isPersistedSessionRow(session))) {
    return defaults ? { ...result, defaults: nextDefaults } : result;
  }
  const visibleKey = existing?.key ?? session.key;
  const visibleSession = preserveRicherThinkingMetadata(
    visibleKey === session.key ? session : { ...session, key: visibleKey },
    existing,
  );
  if (isStaleForActiveSession(visibleSession, existing)) {
    return { ...result, defaults: nextDefaults };
  }
  const sessions =
    showArchived || visibleSession.archived !== true
      ? [
          ...result.sessions.filter((candidate) => candidate.key !== visibleKey),
          visibleSession,
        ].toSorted(compareSessionRowsByUpdatedAt)
      : result.sessions.filter((candidate) => candidate.key !== visibleKey);
  return {
    ...result,
    defaults: nextDefaults,
    count: sessions.length,
    sessions,
  };
}
