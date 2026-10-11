import { isCronRunSessionKey } from "../../../../src/sessions/session-key-utils.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { compareSessionRowsByUpdatedAt } from "../../lib/sessions/navigation.ts";
import { normalizeAgentId, resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  hasSessionChangedAncestorCoverage,
  parseSessionChangedEvent,
  matchesExistingSession,
  reconcileSessionChangedRow,
  sessionChangedSnapshots,
} from "../../lib/sessions/session-row-reconcile.ts";

export type CurrentWorkChange = NonNullable<ReturnType<typeof parseSessionChangedEvent>>[0] & {
  snapshot?: unknown;
  eventTs?: number;
  parentKeys: readonly string[];
  ancestorSnapshots?: readonly unknown[];
};

export const CURRENT_WORK_CHANGE_LIMIT = 1_000;

export type CurrentWorkFence = {
  retiredAt?: number | null;
  observedAt?: number | null;
  authority?: true;
};

export function currentWorkIdentity(session: {
  key: string;
  agentId?: string | null;
  sessionId?: string;
}): string {
  const identity = resolveUiConversationIdentity({}, session.key, session.agentId ?? undefined);
  const agentId = session.agentId ?? identity.agentId;
  // A raw global in one agent and a literal agent:<id>:global are different sessions.
  return JSON.stringify([
    agentId ? normalizeAgentId(agentId) : null,
    identity.sessionKey,
    session.sessionId ?? null,
  ]);
}

export function readCurrentWorkChange(payload: unknown): CurrentWorkChange | null {
  const parsed = parseSessionChangedEvent(payload);
  const change = parsed?.[0];
  const snapshot =
    Array.isArray(parsed?.[1].ancestorSessions) && parsed?.[1].session ? payload : undefined;
  if (
    !change?.sessionId ||
    (!snapshot &&
      change.hasActiveRun === null &&
      change.activeRunIds === undefined &&
      change.status === null &&
      change.reason !== "delete")
  ) {
    return null;
  }
  return {
    ...change,
    parentKeys: [
      parsed?.[2].spawnedBy,
      parsed?.[2].controlOwnerSessionKey,
      parsed?.[2].parentSessionKey,
    ].filter((key): key is string => typeof key === "string" && Boolean(key)),
    ...(typeof parsed?.[1].ts === "number" && Number.isFinite(parsed[1].ts)
      ? { eventTs: parsed[1].ts }
      : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

export function readCurrentWorkChanges(payload: unknown): CurrentWorkChange[] {
  const snapshots = sessionChangedSnapshots(payload);
  return snapshots.flatMap((snapshot) => {
    const change = readCurrentWorkChange(snapshot);
    if (change?.snapshot) {
      // Flattened ancestors retain the original event's coverage, including grandparents.
      change.ancestorSnapshots = snapshots;
    }
    return change ? [change] : [];
  });
}

export function isOlderCurrentWorkChange(
  change: Pick<CurrentWorkChange, "updatedAt" | "snapshotAt">,
  observed: Pick<GatewaySessionRow, "updatedAt" | "snapshotAt">,
): boolean {
  return (
    (change.updatedAt !== null && (observed.updatedAt ?? 0) > change.updatedAt) ||
    (change.snapshotAt !== undefined && (observed.snapshotAt ?? 0) > change.snapshotAt)
  );
}

export function reconcileCurrentWork(
  result: SessionsListResult,
  changes: Iterable<CurrentWorkChange>,
  fences: Map<string, CurrentWorkFence>,
  retirementOverflowed: boolean,
  acceptRead = false,
): {
  result: SessionsListResult;
  requiresRefresh: boolean;
  canPublish: boolean;
  retirementOverflowed: boolean;
} {
  if (acceptRead) {
    for (const [identity, { retiredAt }] of fences) {
      if (typeof retiredAt === "number" && retiredAt > result.ts) {
        fences.set(identity, { retiredAt });
      } else {
        fences.delete(identity);
      }
    }
  }
  const rows = new Map(
    result.sessions.map((row) => [currentWorkIdentity(row), { row, requiresRefresh: false }]),
  );
  for (const [identity, { row }] of rows) {
    const retiredAt = fences.get(identity)?.retiredAt;
    if (
      retiredAt !== undefined &&
      (retiredAt === null || (row.snapshotAt ?? result.ts) <= retiredAt)
    ) {
      rows.delete(identity);
    }
  }
  let overflowed = retirementOverflowed || fences.size >= CURRENT_WORK_CHANGE_LIMIT;
  let requiresAncestorRefresh = false;
  const observe = (
    identity: string,
    fact: "retiredAt" | "observedAt" | "authority",
    sampledAt: number | null,
  ) => {
    if (!fences.has(identity) && fences.size >= CURRENT_WORK_CHANGE_LIMIT) {
      overflowed = true;
      return;
    }
    const fence: CurrentWorkFence = fences.get(identity) ?? {};
    if (fact === "authority") {
      fence.authority = true;
    } else {
      const previous = fence[fact];
      fence[fact] =
        previous === null || sampledAt === null ? null : Math.max(previous ?? 0, sampledAt);
      if (
        fact === "retiredAt" &&
        sampledAt !== null &&
        typeof fence.observedAt === "number" &&
        sampledAt >= fence.observedAt
      ) {
        delete fence.observedAt;
      }
    }
    fences.set(identity, fence);
    overflowed ||= fences.size >= CURRENT_WORK_CHANGE_LIMIT;
  };
  for (const change of changes) {
    const identity = currentWorkIdentity(change);
    const state = rows.get(identity);
    // A stale read can seed a retired child whose lineage still identifies held parents.
    const lineage =
      state?.row ?? result.sessions.find((row) => currentWorkIdentity(row) === identity);
    if (!lineage || !isOlderCurrentWorkChange(change, lineage)) {
      requiresAncestorRefresh ||= !hasSessionChangedAncestorCoverage(
        result.sessions,
        change.key,
        [
          lineage?.spawnedBy,
          lineage?.controlOwnerSessionKey,
          lineage?.parentSessionKey,
          ...change.parentKeys,
        ],
        change.ancestorSnapshots,
      );
    }
    const activeStatus =
      change.status === "running" || change.status === "queued" ? change.status : undefined;
    const active =
      change.hasActiveRun === true || (change.hasActiveRun !== false && activeStatus !== undefined);
    const inactive =
      change.reason === "delete" ||
      (change.hasActiveRun === false &&
        (change.snapshot !== undefined || change.activeRunIds !== undefined || !change.runId));
    const terminal = change.hasActiveRun === false || change.status !== null;
    const retirementAt = change.snapshotAt ?? change.eventTs ?? change.updatedAt;
    if (!state) {
      const fence = fences.get(identity);
      const retiredAt = fence?.retiredAt;
      const coveredRetirement =
        typeof retiredAt === "number" &&
        retirementAt !== null &&
        (retirementAt < retiredAt ||
          (retirementAt === retiredAt && !change.snapshot && !active && !inactive && terminal));
      // Older observations cannot turn a proven retirement back into uncertainty.
      if (coveredRetirement) {
        continue;
      }
      if (
        [...rows.values()].some(({ row }) =>
          matchesExistingSession(row, change.key, change.agentId),
        )
      ) {
        observe(identity, "authority", null);
        if (inactive) {
          observe(identity, "retiredAt", retirementAt);
        }
        continue;
      }
      if (change.isAncestorReference) {
        // An unchanged reference for an entirely unheld target changes no query membership.
        continue;
      }
      if (
        isCronRunSessionKey(change.key) ||
        (change.snapshot && parseSessionChangedEvent(change.snapshot)?.[2].isDock === true)
      ) {
        continue;
      }
      if (
        change.snapshot &&
        change.hasActiveRun === true &&
        change.snapshotAt !== undefined &&
        !result.hasMore &&
        change.snapshotAt < result.ts
      ) {
        continue;
      }
      if (
        change.snapshot &&
        change.reason !== "delete" &&
        change.hasActiveRun === true &&
        change.snapshotAt !== undefined &&
        !overflowed &&
        retiredAt !== null &&
        fence?.observedAt !== null &&
        !fence?.authority &&
        change.snapshotAt > Math.max(result.ts, retiredAt ?? 0, fence?.observedAt ?? 0) &&
        !result.hasMore &&
        rows.size < (result.limitApplied ?? 100)
      ) {
        const row = reconcileSessionChangedRow(undefined, change.snapshot, {
          archivedFilter: "all",
          admitSnapshot: true,
        }).admittedRow;
        if (row?.hasActiveRun === true) {
          rows.set(identity, { row, requiresRefresh: false });
          fences.delete(identity);
          continue;
        }
      }
      if (inactive) {
        observe(identity, "retiredAt", retirementAt);
      } else if (active || terminal) {
        observe(identity, "observedAt", retirementAt);
      }
      continue;
    }
    const { row } = state;
    if (isOlderCurrentWorkChange(change, row)) {
      continue;
    }
    if (change.snapshot) {
      const reduced = reconcileSessionChangedRow(row, change.snapshot, { archivedFilter: "all" });
      if (reduced.admittedRow) {
        state.row = reduced.admittedRow;
        state.requiresRefresh = false;
        if (reduced.admittedRow.hasActiveRun !== true) {
          observe(identity, "retiredAt", retirementAt);
          rows.delete(identity);
        }
      } else if (reduced.deletedKey) {
        rows.delete(identity);
        observe(identity, "retiredAt", retirementAt);
      } else {
        state.requiresRefresh = true;
      }
      continue;
    }
    const next = { ...row, updatedAt: change.updatedAt ?? row.updatedAt };
    if (change.reason === "delete") {
      next.hasActiveRun = false;
      next.activeRunIds = [];
    } else if (active) {
      next.hasActiveRun = true;
      next.status = activeStatus ?? (row.status === "queued" ? "queued" : "running");
      if (change.activeRunIds !== undefined) {
        // Null explicitly retires a previously exact set when only liveness is known.
        next.activeRunIds = change.activeRunIds ?? undefined;
      } else if (change.runId && !row.activeRunIds?.includes(change.runId)) {
        next.activeRunIds = undefined;
      }
    } else {
      if (
        terminal &&
        row.hasActiveRun === true &&
        change.runId &&
        !row.activeRunIds?.includes(change.runId)
      ) {
        // A single old run cannot retire a replacement or an unidentified active run.
        state.requiresRefresh = true;
        continue;
      }
      if (inactive || change.activeRunIds?.length === 0) {
        next.hasActiveRun = false;
        next.activeRunIds = [];
      } else if (terminal) {
        const runIds = change.activeRunIds ?? row.activeRunIds;
        if (!change.runId || !runIds?.includes(change.runId)) {
          state.requiresRefresh = row.hasActiveRun === true;
          continue;
        }
        next.activeRunIds = runIds.filter((id) => id !== change.runId);
        next.hasActiveRun = next.activeRunIds.length > 0;
      } else if (change.activeRunIds !== undefined) {
        next.activeRunIds = change.activeRunIds ?? undefined;
      }
    }
    if (next.hasActiveRun !== true) {
      observe(identity, "retiredAt", retirementAt);
      rows.delete(identity);
      continue;
    }
    state.row = next;
    state.requiresRefresh = false;
  }
  const current = [...rows.values()].filter(({ row }) => row.hasActiveRun === true);
  const sessions = current.map(({ row }) => row).toSorted(compareSessionRowsByUpdatedAt);
  const canPublish = !current.some((state) => state.requiresRefresh);
  const requiresRefresh =
    overflowed ||
    requiresAncestorRefresh ||
    !canPublish ||
    [...fences.values()].some((fence) => fence.authority || fence.observedAt !== undefined) ||
    (result.hasMore === true && sessions.length < result.sessions.length);
  return {
    result: {
      ...result,
      count: sessions.length,
      ...(!result.hasMore ? { totalCount: sessions.length } : {}),
      sessions,
    },
    requiresRefresh,
    canPublish,
    retirementOverflowed: overflowed,
  };
}
