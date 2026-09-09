import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { preserveRosterPresentationMetadata } from "../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeDefaultMainSessionAliasForUi,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";
import { matchesExistingSession } from "../lib/sessions/session-row-reconcile.ts";
export { fetchChildSessionRows } from "../lib/sessions/child-session-data.ts";

const MAX_SESSION_LINEAGE_DEPTH = 16;

type SessionLineageObservation = {
  row: GatewaySessionRow;
  reconcile: SessionCapability["reconcile"];
};

function lineageRowCacheKey(row: GatewaySessionRow, key = row.key): string {
  const agentId = row.agentId?.trim();
  return agentId && !parseAgentSessionKey(normalizeDefaultMainSessionAliasForUi(key))
    ? JSON.stringify([key, normalizeAgentId(agentId)])
    : key;
}

export function collectKnownSessionRows(
  rootRows: readonly GatewaySessionRow[],
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Map<string, GatewaySessionRow> {
  const rows = new Map<string, GatewaySessionRow>();
  for (const row of [...Object.values(childRowsByParent).flat(), ...rootRows]) {
    const key = lineageRowCacheKey(row, normalizeDefaultMainSessionAliasForUi(row.key) || row.key);
    rows.delete(key);
    rows.set(key, row);
  }
  return new Map([...rows.values()].map((row) => [lineageRowCacheKey(row), row]));
}

export async function fetchSessionLineage(params: {
  client: GatewayBrowserClient;
  sessionKey: string;
  knownRows: Map<string, GatewaySessionRow>;
  isCurrent: () => boolean;
  captureReconcile: SessionCapability["captureReconcile"];
  publishSelected?: (
    row: GatewaySessionRow,
    reconcile: SessionCapability["reconcile"],
  ) => GatewaySessionRow | null;
  readSelected?: () => Promise<GatewaySessionRow | undefined>;
}): Promise<{
  rowsByParent: Record<string, GatewaySessionRow[]>;
  topmostRow: GatewaySessionRow | null;
  lookupFailed: boolean;
  selectedObservation?: SessionLineageObservation;
} | null> {
  const rowsByParent: Record<string, GatewaySessionRow[]> = {};
  let currentKey = params.sessionKey;
  let currentAgentId = parseAgentSessionKey(currentKey)?.agentId ?? null;
  let topmostRow: GatewaySessionRow | null = null;
  let lookupFailed = false;
  let selectedObservation: SessionLineageObservation | undefined;
  const visited = new Set<string>();
  try {
    // Session ancestry is untrusted persisted state. Bound traversal so a
    // malformed cycle cannot leave direct child routes spinning forever.
    for (let depth = 0; depth < MAX_SESSION_LINEAGE_DEPTH; depth += 1) {
      const identity = JSON.stringify([currentKey, currentAgentId]);
      if (visited.has(identity)) {
        break;
      }
      visited.add(identity);
      const observedSelected = depth === 0 && params.readSelected;
      let row = observedSelected
        ? await observedSelected()
        : [...params.knownRows.values()].find((candidate) =>
            matchesExistingSession(candidate, currentKey, currentAgentId),
          );
      if (!params.isCurrent()) {
        return null;
      }
      if (observedSelected && !row) {
        break;
      }
      if (!row) {
        const reconcile = depth === 0 ? params.captureReconcile() : undefined;
        const described = await params.client.request<{ session?: GatewaySessionRow | null }>(
          "sessions.describe",
          {
            key: currentKey,
            ...(!parseAgentSessionKey(currentKey) && currentAgentId
              ? { agentId: currentAgentId }
              : {}),
          },
        );
        if (!params.isCurrent()) {
          return null;
        }
        row = described?.session
          ? { ...described.session, runtimeSampledAt: Date.now() }
          : undefined;
        if (!row) {
          break;
        }
        if (reconcile) {
          selectedObservation = { row, reconcile };
          if (params.publishSelected) {
            row = params.publishSelected(row, reconcile) ?? undefined;
            if (!params.isCurrent()) {
              return null;
            }
            if (!row) {
              break;
            }
          }
        }
        params.knownRows.set(lineageRowCacheKey(row), row);
      }
      topmostRow = row;
      const parentKey = resolveUiSessionNavigationParentKey(row);
      if (!parentKey) {
        break;
      }
      const siblings = rowsByParent[parentKey] ?? [];
      rowsByParent[parentKey] = [...siblings.filter((candidate) => candidate.key !== row.key), row];
      // Qualified parents change owners; raw ancestors stay with the accepted row.
      currentAgentId =
        parseAgentSessionKey(parentKey)?.agentId ??
        parseAgentSessionKey(row.key)?.agentId ??
        row.agentId?.trim() ??
        currentAgentId;
      currentKey = parentKey;
    }
  } catch {
    lookupFailed = true;
  }
  return { rowsByParent, topmostRow, lookupFailed, selectedObservation };
}

function mergeChildSessionRows(
  current: Readonly<Record<string, readonly GatewaySessionRow[]>>,
  additions: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Record<string, GatewaySessionRow[]> {
  const merged = Object.fromEntries(
    Object.entries(current).map(([parentKey, rows]) => [parentKey, [...rows]]),
  );
  for (const [parentKey, rows] of Object.entries(additions)) {
    const children = merged[parentKey] ?? [];
    for (const row of rows) {
      if (!children.some((candidate) => candidate.key === row.key)) {
        children.push(row);
      }
    }
    merged[parentKey] = children;
  }
  return merged;
}

/** Retain only the routed ancestry when a refreshed child list omits it (archived or filtered). */
function preserveActiveSessionLineageRows(
  sessionKey: string | null,
  rowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>,
): Readonly<Record<string, readonly GatewaySessionRow[]>> {
  const preserved: Record<string, readonly GatewaySessionRow[]> = {};
  let childKey = sessionKey?.trim();
  const visited = new Set<string>();
  while (childKey && !visited.has(childKey)) {
    visited.add(childKey);
    const parent = Object.entries(rowsByParent).find(([, rows]) =>
      rows.some((row) => areUiSessionKeysEquivalent(row.key, childKey)),
    );
    if (!parent) {
      break;
    }
    preserved[parent[0]] = parent[1].filter((row) => areUiSessionKeysEquivalent(row.key, childKey));
    childKey = parent[0];
  }
  return preserved;
}

export function mergeRefreshedChildSessionRows(
  sessionKey: string | null,
  rowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>,
  parentKey: string,
  rows: GatewaySessionRow[],
): Readonly<Record<string, readonly GatewaySessionRow[]>> {
  const lineage = preserveActiveSessionLineageRows(sessionKey, rowsByParent)[parentKey] ?? [];
  return {
    ...rowsByParent,
    ...mergeChildSessionRows({ [parentKey]: rows }, { [parentKey]: lineage }),
  };
}

export function retireStaleChildSessionRows(
  owner: {
    childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
    loadedChildSessionKeys: ReadonlySet<string>;
    loadingChildSessionKeys: ReadonlySet<string>;
    childSessionErrorsByParent: ReadonlyMap<string, string>;
    requestSessionDataUpdate(): void;
  },
  sessionKey: string | null,
  revalidating: ReadonlySet<string>,
): void {
  const lineage = preserveActiveSessionLineageRows(sessionKey, owner.childSessionRowsByParent);
  const next = { ...owner.childSessionRowsByParent };
  let changed = false;
  for (const [parentKey, rows] of Object.entries(next)) {
    if (
      owner.loadedChildSessionKeys.has(parentKey) ||
      owner.loadingChildSessionKeys.has(parentKey) ||
      owner.childSessionErrorsByParent.has(parentKey) ||
      revalidating.has(parentKey)
    ) {
      continue;
    }
    const retained = lineage[parentKey];
    if (retained?.length === rows.length) {
      continue;
    }
    if (retained) {
      next[parentKey] = retained;
    } else {
      delete next[parentKey];
    }
    changed = true;
  }
  if (changed) {
    owner.childSessionRowsByParent = next;
    owner.requestSessionDataUpdate();
  }
}

type SessionLineageOwner = {
  activeSessionLineageRoot: GatewaySessionRow | null;
  activeSessionLineageSelectedRow: GatewaySessionRow | null;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
  context?: {
    gateway?: { snapshot: { sessionKey?: string | null } };
    sessions: Pick<SessionCapability, "reconcile" | "state">;
  };
  sessionsResult: SessionsListResult | null;
};

export function retainActiveSessionRow(
  owner: SessionLineageOwner,
  row: GatewaySessionRow,
  previous: GatewaySessionRow | undefined,
  inheritRow: SessionCapability["inheritRow"],
): GatewaySessionRow {
  const donor =
    isUiGlobalSessionKey(row.key) &&
    (row.sessionId !== previous?.sessionId ||
      normalizeAgentId(row.agentId) !== normalizeAgentId(previous?.agentId))
      ? undefined
      : previous;
  const accepted = inheritRow(
    row === donor ? row : preserveRosterPresentationMetadata(row, donor),
    row,
    donor,
  );
  return assignActiveSessionRow(owner, accepted, inheritRow);
}

function assignActiveSessionRow(
  owner: SessionLineageOwner,
  row: GatewaySessionRow,
  inheritRow: SessionCapability["inheritRow"],
): GatewaySessionRow {
  owner.activeSessionLineageSelectedRow = row;
  if (
    areUiSessionKeysEquivalent(owner.activeSessionLineageRoot?.key, row.key) &&
    (!isUiGlobalSessionKey(row.key) ||
      normalizeAgentId(owner.activeSessionLineageRoot?.agentId) === normalizeAgentId(row.agentId))
  ) {
    owner.activeSessionLineageRoot = row;
  }
  for (const [parentKey, rows] of Object.entries(owner.childSessionRowsByParent)) {
    const current = rows.find(
      (candidate) =>
        areUiSessionKeysEquivalent(candidate.key, row.key) &&
        (!isUiGlobalSessionKey(row.key) ||
          (candidate.agentId === row.agentId && candidate.sessionId === row.sessionId)),
    );
    if (!current || current === row) {
      continue;
    }
    const child = current.key === row.key ? row : inheritRow({ ...row, key: current.key }, row);
    owner.childSessionRowsByParent = {
      ...owner.childSessionRowsByParent,
      [parentKey]: rows.map((candidate) => (candidate === current ? child : candidate)),
    };
  }
  return row;
}

/** Publish the capability-owned descriptor without admitting it to another roster. */
export function publishObservedSessionRow(
  owner: SessionLineageOwner,
  row: GatewaySessionRow,
  inheritRow: SessionCapability["inheritRow"],
): void {
  assignActiveSessionRow(owner, row, inheritRow);
  owner.activeSessionLineageRoot ??= row;
}

export function publishObservedSessionLineage(
  owner: SessionLineageOwner,
  lineage: NonNullable<Awaited<ReturnType<typeof fetchSessionLineage>>>,
  row: GatewaySessionRow,
  inheritRow: SessionCapability["inheritRow"],
): void {
  publishObservedSessionRow(owner, row, inheritRow);
  const current = (candidate: GatewaySessionRow) =>
    areUiSessionKeysEquivalent(candidate.key, row.key) &&
    candidate.agentId === row.agentId &&
    candidate.sessionId === row.sessionId
      ? row
      : candidate;
  owner.childSessionRowsByParent = mergeChildSessionRows(
    owner.childSessionRowsByParent,
    Object.fromEntries(
      Object.entries(lineage.rowsByParent).map(([key, rows]) => [key, rows.map(current)]),
    ),
  );
  owner.activeSessionLineageRoot = lineage.topmostRow ? current(lineage.topmostRow) : row;
}

export function publishActiveSessionRow(
  owner: SessionLineageOwner,
  row: GatewaySessionRow,
  reconcile: SessionCapability["reconcile"],
  inheritRow: SessionCapability["inheritRow"],
  isCurrent: () => boolean,
): GatewaySessionRow | null {
  // Routed descriptors share the capability's freshness and placement owner;
  // both lineage and child-list completions must publish its accepted row.
  const sessions = owner.context?.sessions;
  if (!isCurrent()) {
    return null;
  }
  const rowIsCurrent = reconcile(row, owner.sessionsResult?.defaults, { archivedFilter: "all" });
  if (!isCurrent()) {
    return null;
  }
  const currentRow = () =>
    sessions?.state.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, row.key),
    );
  if (!rowIsCurrent) {
    // Primary can lag a newer managed row; use the owner's existing admission checks.
    const current = [currentRow(), owner.activeSessionLineageSelectedRow].find(
      (candidate) =>
        candidate &&
        isCurrent() &&
        sessions?.reconcile(candidate, undefined, { archivedFilter: "all" }),
    );
    if (!isCurrent()) {
      return null;
    }
    if (!current) {
      return owner.activeSessionLineageSelectedRow;
    }
  }
  const accepted = currentRow();
  if (accepted) {
    // A current request can still contain a timestamp-rejected row.
    const previous = owner.activeSessionLineageSelectedRow ?? undefined;
    return retainActiveSessionRow(owner, accepted, previous, inheritRow);
  }
  owner.activeSessionLineageSelectedRow = null;
  return null;
}

export function publishActiveSessionLineage(
  owner: SessionLineageOwner,
  sessionKey: string,
  lineage: NonNullable<Awaited<ReturnType<typeof fetchSessionLineage>>>,
  sourceCanonicalListRevision: number,
  inheritRow: SessionCapability["inheritRow"],
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) {
    return;
  }
  const previousRoot = owner.activeSessionLineageRoot;
  const previousSelectedRow = owner.activeSessionLineageSelectedRow;
  const preserveLineageRow = (row: GatewaySessionRow): GatewaySessionRow => {
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? row.agentId?.trim() ?? null;
    const matches = (candidate: GatewaySessionRow) =>
      matchesExistingSession(candidate, row.key, agentId);
    const previous =
      previousSelectedRow && matches(previousSelectedRow)
        ? previousSelectedRow
        : previousRoot && matches(previousRoot)
          ? previousRoot
          : null;
    // Canonical rows own process-current state; cached lineage only donates presentation.
    const canonical = owner.sessionsResult?.sessions.find(matches);
    const source = canonical ?? row;
    return inheritRow(
      preserveRosterPresentationMetadata(source, previous ?? undefined),
      source,
      previous ?? undefined,
    );
  };
  const topmostRow = lineage.topmostRow ? preserveLineageRow(lineage.topmostRow) : null;
  const rowsByParent = Object.fromEntries(
    Object.entries(lineage.rowsByParent).map(([parentKey, rows]) => [
      parentKey,
      rows.map(preserveLineageRow),
    ]),
  );
  owner.childSessionRowsByParent = mergeChildSessionRows(
    owner.childSessionRowsByParent,
    rowsByParent,
  );
  owner.activeSessionLineageRoot = topmostRow;
  // Actual describes keep their issuance receipt; cached lineage still selects
  // the newest held row before applying its primary-list fence.
  const selectedRow =
    lineage.selectedObservation?.row ??
    [
      topmostRow,
      ...Object.values(rowsByParent).flat(),
      ...collectKnownSessionRows(
        owner.sessionsResult?.sessions ?? [],
        owner.childSessionRowsByParent,
      ).values(),
    ]
      .filter(
        (row): row is GatewaySessionRow =>
          row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
      )
      .reduce<GatewaySessionRow | undefined>((freshest, row) => {
        return !freshest || (row.updatedAt ?? 0) > (freshest.updatedAt ?? 0) ? row : freshest;
      }, undefined);
  if (selectedRow) {
    const reconcile: SessionCapability["reconcile"] =
      lineage.selectedObservation?.reconcile ??
      ((row, defaults, options) =>
        owner.context?.sessions.reconcile(row, defaults, {
          ...options,
          sourceCanonicalListRevision,
        }) ?? false);
    publishActiveSessionRow(owner, selectedRow, reconcile, inheritRow, isCurrent);
  } else {
    owner.activeSessionLineageSelectedRow = lineage.lookupFailed ? previousSelectedRow : null;
  }
}

export function evictArchivedSessionLineage(
  owner: Parameters<typeof publishActiveSessionLineage>[0],
  sessionKey: string | null,
): void {
  if (!sessionKey) {
    return;
  }
  const routedSessionKey = owner.context?.gateway?.snapshot.sessionKey?.trim();
  if (routedSessionKey && areUiSessionKeysEquivalent(routedSessionKey, sessionKey)) {
    // Sidebar lineage can momentarily retarget while the archived route remains
    // selected. The routed descriptor still owns pane/header presentation and
    // must survive until application navigation actually moves elsewhere.
    return;
  }
  const selectedRow =
    owner.sessionsResult?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, sessionKey)) ??
    [
      owner.activeSessionLineageSelectedRow,
      owner.activeSessionLineageRoot,
      ...Object.values(owner.childSessionRowsByParent).flat(),
    ].find(
      (row): row is GatewaySessionRow =>
        row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
    );
  if (selectedRow?.archived === true) {
    // Navigation has ended the archived row's temporary presentation lease.
    // Remove it from the child cache before the next canonical list refresh.
    owner.childSessionRowsByParent = Object.fromEntries(
      Object.entries(owner.childSessionRowsByParent).map(([parentKey, rows]) => [
        parentKey,
        rows.filter((row) => !areUiSessionKeysEquivalent(row.key, sessionKey)),
      ]),
    );
    owner.context?.sessions.reconcile(selectedRow, owner.sessionsResult?.defaults, {
      archivedFilter: "active",
    });
  }
}
