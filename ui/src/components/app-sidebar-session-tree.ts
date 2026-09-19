import type { GatewaySessionRow } from "../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  normalizeDefaultMainSessionAliasForUi,
} from "../lib/sessions/session-key.ts";
import {
  collectSidebarSessionChildKeys,
  resolveSidebarSessionParentKey,
} from "./app-sidebar-session-parent.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarKnownSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

function attributeChildAttention(
  attention: SidebarSessionAttention,
  childLabel: string,
): SidebarSessionAttention {
  return attention.kind === "error" && attention.childLabel === undefined
    ? { ...attention, childLabel }
    : attention;
}

function summarizeChildren(
  children: readonly SidebarRecentSession[],
  knownAttention: readonly SidebarSessionAttention[],
  onlySubagents = false,
) {
  const childAttention: SidebarSessionAttention[] = [];
  let unreadChildCount = 0;
  let runningChildCount = 0;
  let failedChildCount = 0;
  let queuedChildCount = 0;
  let workspaceConflictCount = 0;
  for (const child of children) {
    if (onlySubagents && !isSubagentSessionKey(child.key)) {
      continue;
    }
    const descendants = onlySubagents ? child.subagentSummary : child;
    childAttention.push(
      attributeChildAttention(child.ownAttention ?? child.attention, child.label),
      ...(descendants?.childAttention ?? []),
    );
    unreadChildCount += Number(child.unread) + (descendants?.unreadChildCount ?? 0);
    runningChildCount += (child.hasActiveRun ? 1 : 0) + (descendants?.runningChildCount ?? 0);
    failedChildCount +=
      Number(child.status === "failed" || child.status === "timeout") +
      (descendants?.failedChildCount ?? 0);
    queuedChildCount +=
      Number(child.hasActiveRun && child.status === "queued") +
      (descendants?.queuedChildCount ?? 0);
    workspaceConflictCount += onlySubagents
      ? (child.ownWorkspaceConflictCount ?? 0) + (descendants?.workspaceConflictCount ?? 0)
      : (child.workspaceConflictCount ?? 0);
  }
  childAttention.push(...knownAttention);
  return {
    childAttention: [
      ...new Map(
        childAttention
          .filter((value) => value.kind !== "none")
          .map((value) => [JSON.stringify(value), value]),
      ).values(),
    ],
    unreadChildCount,
    runningChildCount,
    failedChildCount,
    queuedChildCount,
    workspaceConflictCount,
  };
}

/**
 * Pure projection of flat session rows into the sidebar's parent/child tree.
 * Child links come from both directions (parent childSessions lists and child
 * spawnedBy/parentSessionKey backrefs); the ancestor set guards against cycles
 * in malformed link data.
 */
export function projectSessionTree(params: {
  roots: readonly GatewaySessionRow[];
  mainSessionKeys?: ReadonlySet<string>;
  rowsByKey: ReadonlyMap<string, GatewaySessionRow>;
  loadingChildKeys: ReadonlySet<string>;
  knownSessionAttention: readonly SidebarKnownSessionAttention[];
  toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession;
}): SidebarRecentSession[] {
  const {
    roots,
    mainSessionKeys = new Set<string>(),
    rowsByKey,
    loadingChildKeys,
    knownSessionAttention,
    toSidebarSession,
  } = params;
  const childKeysByParent = collectSidebarSessionChildKeys(rowsByKey, mainSessionKeys);
  const hasRootCategory = (row: GatewaySessionRow | undefined) =>
    typeof row?.category === "string" &&
    row.category.trim().length > 0 &&
    !isSubagentSessionKey(row.key);

  const nestedKeys = new Set<string>();
  const build = (
    row: GatewaySessionRow,
    isChild: boolean,
    ancestors: Set<string>,
  ): SidebarRecentSession => {
    const childSessionKeys =
      row.archived === true
        ? []
        : (childKeysByParent.get(normalizeDefaultMainSessionAliasForUi(row.key)) ?? []).filter(
            (key) => !hasRootCategory(rowsByKey.get(key)),
          );
    const ownsAncestor = !ancestors.has(row.key);
    ancestors.add(row.key);
    const navigationChildKeys: string[] = [];
    const childLoadParentKeys = new Set<string>([row.key]);
    const descendants = childSessionKeys.flatMap((key) => {
      const child = rowsByKey.get(key);
      const projectedChild = child && !ancestors.has(key) ? build(child, true, ancestors) : null;
      navigationChildKeys.push(
        ...(isSubagentSessionKey(key) ? (projectedChild?.childSessionKeys ?? []) : [key]),
      );
      if (isSubagentSessionKey(key)) {
        for (const parentKey of projectedChild?.childLoadParentKeys ?? []) {
          childLoadParentKeys.add(parentKey);
        }
      }
      return projectedChild ? [projectedChild] : [];
    });
    // Runs contribute to the same transitive fold as persistent children, but
    // only persistent sessions participate in sidebar navigation and expansion.
    const children = descendants.flatMap((child) =>
      isSubagentSessionKey(child.key) ? child.children : [child],
    );
    children.forEach((child) => nestedKeys.add(child.key));
    // Aliased map entries can share row.key with an ancestor; only remove our own entry.
    if (ownsAncestor) {
      ancestors.delete(row.key);
    }
    const projected = toSidebarSession(row, isChild);
    const unloadedChildKeys = childSessionKeys.filter((key) => !rowsByKey.has(key));
    // Only direct unloaded children can match: parents carry their keys, but not grandchildren's.
    // Grandchildren join the normal transitive fold after their branch is materialized.
    const unloadedAttention = knownSessionAttention.filter((entry) =>
      unloadedChildKeys.some((key) => areUiSessionKeysEquivalent(entry.sessionKey, key)),
    );
    const summary = summarizeChildren(
      descendants,
      unloadedAttention.map((entry) => entry.attention),
    );
    const subagentSummary = summarizeChildren(
      descendants,
      unloadedAttention
        .filter((entry) => isSubagentSessionKey(entry.sessionKey))
        .map((entry) => entry.attention),
      true,
    );
    // Unloaded terminal outcomes require the existing child-detail loader.
    // Child attention is transitive just like live-run counts: a collapsed
    // ancestor remains actionable even when the blocked descendant is hidden.
    const attention = summarizeSidebarSessionAttention([
      projected.attention,
      ...summary.childAttention,
    ]);
    // Sum descendants before adding the parent's conflicts, then clamp once.
    const workspaceConflictCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (projected.workspaceConflictCount ?? 0) + summary.workspaceConflictCount,
    );
    // The Gateway flag includes the row's own live or queued subagent run.
    // Only an idle row proves unloaded descendant work from that flag alone.
    const hasUnloadedDescendantRun =
      row.archived !== true && !projected.hasActiveRun && row.hasActiveSubagentRun;
    subagentSummary.runningChildCount = Math.max(
      subagentSummary.runningChildCount,
      hasUnloadedDescendantRun && summary.runningChildCount === 0 ? 1 : 0,
    );
    return {
      ...projected,
      ...summary,
      ownAttention: projected.attention,
      ownWorkspaceConflictCount: projected.workspaceConflictCount,
      subagentSummary,
      attention,
      childSessionKeys: navigationChildKeys,
      // Hidden runs still need reads to discover their persistent descendants.
      childLoadParentKeys: childSessionKeys.length > 0 ? [...childLoadParentKeys] : [],
      children,
      loadingChildren: [...childLoadParentKeys].some((key) => loadingChildKeys.has(key)),
      containsActiveDescendant: children.some(
        (child) => child.active || child.visuallyActive || child.containsActiveDescendant,
      ),
      workspaceConflictCount: workspaceConflictCount || undefined,
      runningChildCount: Math.max(summary.runningChildCount, hasUnloadedDescendantRun ? 1 : 0),
    };
  };

  const rootKeys = new Set(roots.map((row) => row.key));
  const reattachedRoots = new Set<string>();
  const projectedRoots = roots
    .filter((row) => {
      if (isSubagentSessionKey(row.key)) {
        return false;
      }
      if (hasRootCategory(row)) {
        return true;
      }
      const parentKey = resolveSidebarSessionParentKey(row, mainSessionKeys);
      if (parentKey && isSubagentSessionKey(parentKey)) {
        reattachedRoots.add(row.key);
        return true;
      }
      return !parentKey || !rootKeys.has(parentKey);
    })
    .map((row) => build(row, false, new Set()));
  // A missing or archived ancestor cannot reattach a row; keep its existing root fallback.
  return projectedRoots.filter((row) => !reattachedRoots.has(row.key) || !nestedKeys.has(row.key));
}
