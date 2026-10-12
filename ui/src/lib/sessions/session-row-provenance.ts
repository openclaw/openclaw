import {
  SESSION_DASHBOARD_ROW_FIELDS,
  SESSION_ROW_DETAIL_FIELDS,
} from "../../../../packages/gateway-protocol/src/session-row-fields.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
} from "./session-key.ts";
import { isShallowEqualSessionRow } from "./session-row-equality.ts";

const enrichmentFields = ["derivedTitle", "lastMessagePreview", "activitySummary"] as const;

/** Row identity and one read revision; individual fields do not carry custody records. */
export function createSessionRowProvenance() {
  type Observation = { revision: number; agentId: string | null; cleared?: ReadonlySet<string> };
  let observations = new WeakMap<GatewaySessionRow, Observation>();
  const owner = (row: GatewaySessionRow, agentId?: string | null) => {
    const resolved =
      parseAgentSessionKey(row.key)?.agentId ??
      row.agentId?.trim() ??
      observations.get(row)?.agentId ??
      agentId?.trim();
    return resolved ? normalizeAgentId(resolved) : null;
  };
  const identity = (row: GatewaySessionRow, agentId?: string | null) => {
    const resolved = owner(row, agentId);
    return !row.sessionId?.trim() || (isUiGlobalSessionKey(row.key) && !resolved)
      ? null
      : JSON.stringify([normalizeDefaultMainSessionAliasForUi(row.key), resolved, row.sessionId]);
  };
  const rowRevision = (row: GatewaySessionRow) => observations.get(row)?.revision ?? 0;
  const observeReadRow = (row: GatewaySessionRow, revision: number, agentId?: string | null) => {
    observations.set(row, { revision, agentId: owner(row, agentId) });
  };
  const observeClears = (row: GatewaySessionRow, fields: readonly string[]) => {
    const cleared = new Set(observations.get(row)?.cleared);
    const values: Record<string, unknown> = row;
    for (const field of fields) {
      if (values[field] === undefined) {
        Reflect.deleteProperty(row, field);
        cleared.add(field);
      }
    }
    const observation = observations.get(row);
    if (observation && cleared.size > 0) {
      observations.set(row, { ...observation, cleared });
    }
  };
  const inheritRow = (row: GatewaySessionRow, source: GatewaySessionRow | undefined) => {
    if (observations.has(row)) {
      return row;
    }
    if (source && identity(row, owner(source)) === identity(source)) {
      const observed = observations.get(source);
      if (observed) {
        observations.set(row, observed);
      }
    }
    return row;
  };
  const mergeRow = (
    current: GatewaySessionRow,
    offered: GatewaySessionRow,
    agentId?: string | null,
  ): GatewaySessionRow => {
    if (
      current === offered ||
      !identity(current, agentId) ||
      identity(current, agentId) !== identity(offered, agentId)
    ) {
      return current;
    }
    const newer =
      offered.snapshotAt !== undefined &&
      current.snapshotAt !== undefined &&
      offered.snapshotAt !== current.snapshotAt
        ? offered.snapshotAt > current.snapshotAt
          ? offered
          : current
        : offered.updatedAt != null &&
            current.updatedAt != null &&
            offered.updatedAt !== current.updatedAt
          ? offered.updatedAt > current.updatedAt
            ? offered
            : current
          : rowRevision(offered) >= rowRevision(current)
            ? offered
            : current;
    const older = newer === offered ? current : offered;
    const olderValues: Record<string, unknown> = older;
    const next = { ...newer, key: current.key };
    // Compact rows and optional enrichment omit fields rather than clearing them.
    for (const field of [
      ...enrichmentFields,
      ...(newer.rowMode === "dashboard"
        ? Object.keys(older).filter((name) => !SESSION_DASHBOARD_ROW_FIELDS.has(name))
        : newer.rowMode === "compact"
          ? SESSION_ROW_DETAIL_FIELDS
          : []),
    ]) {
      if (
        !Object.hasOwn(next, field) &&
        !observations.get(newer)?.cleared?.has(field) &&
        olderValues[field] !== undefined
      ) {
        Object.assign(next, { [field]: olderValues[field] });
      }
    }
    if (next.swarm && older.swarm) {
      next.swarm = {
        ...next.swarm,
        groups: next.swarm.groups.map((group) => {
          const previous = older.swarm?.groups.find((item) => item.groupId === group.groupId);
          return group.children === undefined &&
            previous?.children &&
            JSON.stringify({ ...group, children: undefined }) ===
              JSON.stringify({ ...previous, children: undefined })
            ? { ...group, children: previous.children }
            : group;
        }),
      };
    }
    const result =
      next.snapshotAt === current.snapshotAt && isShallowEqualSessionRow(next, current)
        ? current
        : next;
    const observation = observations.get(newer);
    if (observation) {
      observations.set(result, observation);
    }
    return result;
  };
  return {
    owner,
    identity,
    inheritRow,
    mergeRow,
    observeReadRow,
    observeClears,
    rowRevision,
    reset: () => {
      observations = new WeakMap();
    },
    bindOwner: (row: GatewaySessionRow, agentId?: string | null) => {
      if (!observations.has(row)) {
        observeReadRow(row, 0, agentId);
      }
    },
    hasObservation: (row: GatewaySessionRow) => rowRevision(row) > 0,
  };
}
