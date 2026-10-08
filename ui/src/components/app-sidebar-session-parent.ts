import {
  isCronSessionDisplayKey,
  isSystemCreatedSessionRow,
} from "../../../src/shared/session-list-visibility.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { activeSessionAgentStatus } from "../lib/session-attention.ts";
import {
  sessionMatchesArchivedFilter,
  type SessionArchivedFilter,
} from "../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  normalizeDefaultMainSessionAliasForUi,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";

/** Resolve visual placement without changing persisted routing or transcript ancestry. */
export function resolveSidebarSessionParentKey(
  row: GatewaySessionRow | undefined,
  mainSessionKeys: ReadonlySet<string>,
  listedParentKey?: string,
): string | undefined {
  const parentKey = resolveUiSessionNavigationParentKey(row) ?? listedParentKey;
  // Operator roots carry an implicit Home link for notices. Explicit creation
  // records the parent's generation; delegation and forks have their own markers.
  // Older rows without creation provenance keep their existing placement.
  if (
    parentKey &&
    row?.createdVia === "operator" &&
    row.spawnDepth === 0 &&
    !row.parentSessionId &&
    !row.spawnedBy &&
    !row.forkSource &&
    row.forkedFromParent !== true &&
    !isSubagentSessionKey(row.key) &&
    [...mainSessionKeys].some((key) => areUiSessionKeysEquivalent(key, parentKey))
  ) {
    return undefined;
  }
  return parentKey;
}

/** Child-side navigation ancestry overrides parent-owned child lists. */
export function collectSidebarSessionChildKeys(
  rowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  mainSessionKeys: ReadonlySet<string>,
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  const append = (parentKey: string, childKey: string) => {
    const key = normalizeDefaultMainSessionAliasForUi(parentKey);
    const keys = children.get(key) ?? [];
    if (!keys.includes(childKey)) {
      keys.push(childKey);
      children.set(key, keys);
    }
  };
  for (const row of rowsByKey.values()) {
    for (const childKey of row.childSessions ?? []) {
      const parent = resolveSidebarSessionParentKey(
        rowsByKey.get(childKey),
        mainSessionKeys,
        row.key,
      );
      if (areUiSessionKeysEquivalent(parent, row.key)) {
        append(row.key, childKey);
      }
    }
  }
  for (const row of rowsByKey.values()) {
    const parent = resolveSidebarSessionParentKey(row, mainSessionKeys);
    if (parent) {
      append(parent, row.key);
    }
  }
  return children;
}

/** Hidden runs keep failures on their own notice path; only plain unread state folds into reads. */
export function isAcknowledgeableHiddenRun(
  row: Pick<GatewaySessionRow, "key" | "unread" | "status" | "archived" | "agentStatus">,
): boolean {
  return (
    isSubagentSessionKey(row.key) &&
    row.archived !== true &&
    row.unread === true &&
    row.status !== "failed" &&
    row.status !== "timeout" &&
    !activeSessionAgentStatus(row)?.attention
  );
}

/** Walk the same ancestry used by sidebar folding, preserving each source row. */
export function collectSessionDescendantRows(
  rows: readonly GatewaySessionRow[],
  parentKey: string,
  subagentsOnly = false,
): GatewaySessionRow[] {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const childKeysByParent = collectSidebarSessionChildKeys(rowsByKey, new Set());
  const visited = new Set<string>([parentKey]);
  const descendants: GatewaySessionRow[] = [];
  const visit = (key: string) => {
    if (rowsByKey.get(key)?.archived) {
      return;
    }
    for (const childKey of childKeysByParent.get(normalizeDefaultMainSessionAliasForUi(key)) ??
      []) {
      const child = rowsByKey.get(childKey);
      if (
        !child ||
        child.archived ||
        (subagentsOnly && !isSubagentSessionKey(childKey)) ||
        visited.has(childKey)
      ) {
        continue;
      }
      visited.add(childKey);
      descendants.push(child);
      visit(childKey);
    }
  };
  visit(parentKey);
  return descendants;
}

/** Persistent descendants own sidebar rows and stay unread until opened. */
export function collectUnreadHiddenRunRows(
  rows: readonly GatewaySessionRow[],
  parentKey: string,
): GatewaySessionRow[] {
  return collectSessionDescendantRows(rows, parentKey, true).filter(isAcknowledgeableHiddenRun);
}

/** Promote the first persistent conversations below Home, honoring the active filters. */
export function collectPromotedMainChildRows(input: {
  rows: readonly GatewaySessionRow[];
  childKeysByParent: ReadonlyMap<string, readonly string[]>;
  mainSessionKeys: ReadonlySet<string>;
  scopedRootKeys: ReadonlySet<string>;
  showCron: boolean;
  showSystem: boolean;
  archivedFilter: SessionArchivedFilter;
}): GatewaySessionRow[] {
  const parents = new Set([...input.mainSessionKeys].map(normalizeDefaultMainSessionAliasForUi));
  const promoted = new Set<string>();
  // Set iteration visits newly discovered runs once, including malformed cycles.
  for (const parent of parents) {
    for (const key of input.childKeysByParent.get(parent) ?? []) {
      if (isSubagentSessionKey(key)) {
        parents.add(normalizeDefaultMainSessionAliasForUi(key));
      } else {
        promoted.add(key);
      }
    }
  }
  return input.rows.filter(
    (row) =>
      promoted.has(row.key) &&
      !input.scopedRootKeys.has(row.key) &&
      !isSubagentSessionKey(row.key) &&
      sessionMatchesArchivedFilter(row, input.archivedFilter) &&
      (input.showCron || !isCronSessionDisplayKey(row.key)) &&
      (input.showSystem || !isSystemCreatedSessionRow(row)),
  );
}
