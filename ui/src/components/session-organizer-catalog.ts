// Catalog operations never patch session rows; the one-way dependency from
// session-organizer-operations.runtime.ts keeps group assignment cycle-free.
import { t } from "../i18n/index.ts";
import { moveSessionSection, normalizeSessionSectionOrder } from "../lib/sessions/grouping.ts";
import type { SessionGroupMutationResult } from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import {
  requireSessionMutationAccess,
  type SessionActionHost,
} from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerDependencies } from "./session-organizer.ts";

export type SessionGroupActionHost = SessionActionHost & {
  knownSessionGroups(): string[];
};

export async function rememberSessionGroup(
  deps: SessionGroupActionHost,
  name: string,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  const groups = deps.knownSessionGroups();
  if (groups.includes(name)) {
    return "completed";
  }
  return writeSessionGroup(deps, scope, "sessions.groups.put", () =>
    scope.sessions.groupsPut([...groups, name]),
  );
}

export async function renameSessionGroup(
  deps: SessionOrganizerDependencies,
  group: string,
  next: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  return (
    (await writeSessionGroup(deps, scope, "sessions.groups.rename", () =>
      scope.sessions.groupsRename(group, next),
    )) === "completed"
  );
}

export async function deleteSessionGroup(
  deps: SessionOrganizerDependencies,
  group: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
    return false;
  }
  if (
    !requireSessionMutationAccess(deps, scope, {
      method: "sessions.groups.delete",
      requiredScope: "operator.write",
    })
  ) {
    return false;
  }
  // Deleting a group keeps its sessions: the Gateway drops the catalog row and
  // clears the category on every member, so the confirm names that outcome. It
  // follows the access check so nobody is asked about a delete that cannot run.
  const confirmed = await showConfirmDialog({
    title: t("sessionsView.deleteGroupTitle", { group }),
    message: t("sessionsView.deleteGroupConfirm"),
    confirmLabel: t("common.delete"),
    danger: true,
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteGroupStale", { group }) });
    return false;
  }
  if (!confirmed) {
    return false;
  }
  try {
    const outcome = await scope.sessions.groupsDelete(group);
    return outcome === "completed" && deps.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    deps.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export function updateSessionGroupDefaults(
  deps: SessionOrganizerDependencies,
  group: string,
  defaults: { cwd: string | null; worktree: boolean },
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  return writeSessionGroup(deps, scope, "sessions.groups.update", () =>
    scope.sessions.groupsUpdate(group, defaults),
  );
}

async function writeSessionGroup(
  deps: SessionActionHost,
  scope: SidebarSessionMutationScope,
  method: "sessions.groups.put" | "sessions.groups.rename" | "sessions.groups.update",
  write: () => Promise<SessionGroupMutationResult>,
): Promise<SidebarSessionMutationResult> {
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  if (!requireSessionMutationAccess(deps, scope, { method, requiredScope: "operator.write" })) {
    return "failed";
  }
  try {
    const outcome = await write();
    // The catalog and this caller each own a stale signal; neither can confirm the other's write.
    return outcome === "completed" && deps.sessionData.isSessionMutationScopeCurrent(scope)
      ? "completed"
      : "stale";
  } catch (error) {
    if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    deps.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

export async function reorderSidebarSection(
  deps: SessionOrganizerDependencies,
  sourceSectionId: string,
  targetSectionId: string,
  position: "before" | "after",
  scope: SidebarSessionMutationScope,
  notify: () => void,
): Promise<void> {
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (
    !requireSessionMutationAccess(deps, scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    })
  ) {
    return;
  }
  try {
    // knownSessionGroups() is the full discovered set (gateway catalog plus
    // row-discovered categories), so normalize only prunes deleted groups.
    const knownGroups = deps.knownSessionGroups();
    const knownCatalogIds = deps.knownSessionCatalogIds();
    const next = moveSessionSection(
      normalizeSessionSectionOrder(deps.knownSectionOrder(), knownGroups, knownCatalogIds),
      sourceSectionId,
      targetSectionId,
      position,
    );
    const nextGroups = next.flatMap((token) =>
      token.startsWith("category:") ? [token.slice("category:".length)] : [],
    );
    // No capability gate: the gateway serves this UI from its own dist, so a
    // newer UI never talks to an older gateway's closed put schema outside dev.
    await scope.sessions.groupsPut(nextGroups, next);
    if (deps.sessionData.isSessionMutationScopeCurrent(scope)) {
      // Publish the row move before completion restores its keyboard focus.
      notify();
    }
  } catch (error) {
    deps.sessionData.publishSessionMutationError(scope, error);
  }
}
