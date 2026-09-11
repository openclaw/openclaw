import type { GatewaySessionRow } from "../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  rowDemandsVisibility,
  RowVisibilityReason,
  sidebarSessionAttentionPriority,
  type SidebarKnownSessionAttention,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

/**
 * Pure projection of flat session rows into the sidebar's parent/child tree.
 * Child links come from both directions (parent childSessions lists and child
 * spawnedBy/parentSessionKey backrefs); the ancestor set guards against cycles
 * in malformed link data.
 */
export function projectSessionTree(params: {
  roots: readonly GatewaySessionRow[];
  rowsByKey: ReadonlyMap<string, GatewaySessionRow>;
  loadingChildKeys: ReadonlySet<string>;
  knownSessionAttention: readonly SidebarKnownSessionAttention[];
  toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession;
}): SidebarRecentSession[] {
  const { roots, rowsByKey, loadingChildKeys, knownSessionAttention, toSidebarSession } = params;
  const childKeysByParent = new Map<string, string[]>();
  const hasExplicitCategory = (row: GatewaySessionRow | undefined) =>
    typeof row?.category === "string" && row.category.trim().length > 0;
  const appendChild = (parentKey: string, childKey: string) => {
    const keys = childKeysByParent.get(parentKey) ?? [];
    if (!keys.includes(childKey)) {
      keys.push(childKey);
      childKeysByParent.set(parentKey, keys);
    }
  };
  for (const row of rowsByKey.values()) {
    for (const childKey of row.childSessions ?? []) {
      const child = rowsByKey.get(childKey);
      // Manual category placement is a first-class sidebar destination. Once
      // a child is explicitly categorized, render it as a section root rather
      // than hiding it behind its lineage parent.
      if (hasExplicitCategory(child)) {
        continue;
      }
      const navigationParentKey = resolveUiSessionNavigationParentKey(child);
      // Runtime control and sidebar navigation can have different parents;
      // known children belong to their explicit navigation parent only.
      if (!navigationParentKey || areUiSessionKeysEquivalent(navigationParentKey, row.key)) {
        appendChild(row.key, childKey);
      }
    }
  }
  for (const row of rowsByKey.values()) {
    const parentKey = resolveUiSessionNavigationParentKey(row);
    if (parentKey && !hasExplicitCategory(row)) {
      appendChild(parentKey, row.key);
    }
  }

  const build = (
    row: GatewaySessionRow,
    isChild: boolean,
    ancestors: Set<string>,
  ): SidebarRecentSession => {
    const childSessionKeys = row.archived === true ? [] : (childKeysByParent.get(row.key) ?? []);
    const ownsAncestor = !ancestors.has(row.key);
    ancestors.add(row.key);
    const children = childSessionKeys.flatMap((key) => {
      const child = rowsByKey.get(key);
      return child && !ancestors.has(key) ? [build(child, true, ancestors)] : [];
    });
    // Aliased map entries can share row.key with an ancestor; only remove our own entry.
    if (ownsAncestor) {
      ancestors.delete(row.key);
    }
    const projected = toSidebarSession(row, isChild);
    const unloadedChildKeys = childSessionKeys.filter((key) => !rowsByKey.has(key));
    // Only direct unloaded children can match: parents carry their keys, but not grandchildren's.
    // Grandchildren join the normal transitive fold after their branch is materialized.
    const unloadedChildAttention = knownSessionAttention.reduce(
      (current, entry) =>
        unloadedChildKeys.some((key) => areUiSessionKeysEquivalent(entry.sessionKey, key)) &&
        sidebarSessionAttentionPriority(entry.attention) > sidebarSessionAttentionPriority(current)
          ? entry.attention
          : current,
      SIDEBAR_SESSION_NO_ATTENTION,
    );
    // Accepted gap: an unloaded failed child needs expansion before its error attention can surface.
    // Child attention is transitive just like live-run counts: a collapsed
    // ancestor remains actionable even when the blocked descendant is hidden.
    let attention =
      sidebarSessionAttentionPriority(unloadedChildAttention) >
      sidebarSessionAttentionPriority(projected.attention)
        ? unloadedChildAttention
        : projected.attention;
    let runningChildCount = 0;
    let failedChildCount = 0;
    let childWorkspaceConflictCount = 0;
    let containsActiveDescendant = false;
    for (const child of children) {
      runningChildCount =
        runningChildCount + (child.hasActiveRun ? 1 : 0) + child.runningChildCount;
      failedChildCount =
        failedChildCount +
        (child.status === "failed" || child.status === "timeout" ? 1 : 0) +
        child.failedChildCount;
      childWorkspaceConflictCount += child.workspaceConflictCount ?? 0;
      if (
        rowDemandsVisibility(child, RowVisibilityReason.Attention) &&
        sidebarSessionAttentionPriority(child.attention) >
          sidebarSessionAttentionPriority(attention)
      ) {
        attention = child.attention;
      }
      containsActiveDescendant ||=
        child.active || child.visuallyActive || child.containsActiveDescendant;
    }
    // Sum descendants before adding the parent's conflicts, then clamp once.
    const workspaceConflictCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (projected.workspaceConflictCount ?? 0) + childWorkspaceConflictCount,
    );
    // The Gateway flag includes the row's own live or queued subagent run.
    // Only an idle row proves unloaded descendant work from that flag alone.
    const hasUnloadedDescendantRun =
      row.archived !== true && !projected.hasActiveRun && row.hasActiveSubagentRun;
    return {
      ...projected,
      attention,
      childSessionKeys,
      children,
      loadingChildren: loadingChildKeys.has(row.key),
      containsActiveDescendant,
      workspaceConflictCount: workspaceConflictCount || undefined,
      runningChildCount: Math.max(runningChildCount, hasUnloadedDescendantRun ? 1 : 0),
      failedChildCount,
    };
  };

  const rootKeys = new Set(roots.map((row) => row.key));
  return roots
    .filter((row) => {
      if (hasExplicitCategory(row)) {
        return true;
      }
      const parentKey = resolveUiSessionNavigationParentKey(row);
      return !parentKey || !rootKeys.has(parentKey);
    })
    .map((row) => build(row, false, new Set()));
}
