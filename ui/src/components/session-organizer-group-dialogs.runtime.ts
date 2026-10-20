import { t } from "../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerDependencies } from "./session-organizer-types.ts";

registerSessionOrganizationEnglish();

async function loadDialog<T>(deps: SessionOrganizerDependencies, load: Promise<T>) {
  try {
    return await load;
  } catch (error) {
    const scope = deps.sessionData.beginSessionMutation();
    if (scope) {
      deps.sessionData.publishSessionMutationError(scope, error);
    }
    return null;
  }
}

async function loadOperations(
  deps: SessionOrganizerDependencies,
  scope: SidebarSessionMutationScope,
) {
  try {
    return await import("./session-organizer-operations.runtime.ts");
  } catch (error) {
    deps.sessionData.publishSessionMutationError(scope, error);
    return null;
  }
}

export async function createSessionGroupDialog(
  deps: SessionOrganizerDependencies,
  scope: SidebarSessionMutationScope,
  signal: AbortSignal,
  sessions: readonly SidebarRecentSession[],
  notify: () => void,
) {
  const dialog = await loadDialog(deps, import("./input-dialog.ts"));
  await dialog?.showInputDialog({
    signal,
    gateway: scope.gateway,
    title: t("sessionsView.newGroupTitle"),
    label: t("sessionsView.newGroupPrompt"),
    submitLabel: t("sessionsView.newGroupCreate"),
    requireValue: true,
    submit: async (name) => {
      const currentScope = deps.sessionData.beginSessionMutation();
      if (!currentScope) {
        return t("sessionsView.newGroupFailed");
      }
      const operations = await loadOperations(deps, currentScope);
      if (!operations) {
        return deps.sessionData.isSessionMutationScopeCurrent(currentScope)
          ? (deps.sessionData.sessionMutationError ?? t("sessionsView.newGroupFailed"))
          : t("sessionsView.newGroupStale");
      }
      const result = await operations.createSessionGroup(deps, name, sessions, currentScope);
      if (result === "completed" && sessions.length === 0) {
        notify();
      }
      if (result === "failed") {
        return deps.sessionData.sessionMutationError ?? t("sessionsView.newGroupFailed");
      }
      return result === "stale" ? t("sessionsView.newGroupStale") : null;
    },
  });
}

export async function renameSessionGroupDialog(
  deps: SessionOrganizerDependencies,
  scope: SidebarSessionMutationScope,
  signal: AbortSignal,
  group: string,
  onRenamed: (next: string) => void,
) {
  const dialog = await loadDialog(deps, import("./input-dialog.ts"));
  await dialog?.showInputDialog({
    signal,
    gateway: scope.gateway,
    title: t("sessionsView.renameGroupTitle", { group }),
    label: t("sessionsView.groupNameLabel"),
    defaultValue: group,
    requireValue: true,
    requireChange: true,
    submit: async (next) => {
      const currentScope = deps.sessionData.beginSessionMutation();
      if (!currentScope) {
        return t("sessionsView.actionRequiresConnection");
      }
      const operations = await loadOperations(deps, currentScope);
      if (!operations || !(await operations.renameSessionGroup(deps, group, next, currentScope))) {
        return deps.sessionData.isSessionMutationScopeCurrent(currentScope)
          ? (deps.sessionData.sessionMutationError ?? t("sessionsView.renameGroupFailed"))
          : t("sessionsView.renameSessionStale");
      }
      // Collapse keys follow only a confirmed Gateway rename.
      onRenamed(next);
      return null;
    },
  });
}

export async function editSessionGroupDefaultsDialog(
  deps: SessionOrganizerDependencies,
  scope: SidebarSessionMutationScope,
  group: string,
) {
  const dialog = await loadDialog(deps, import("./session-group-defaults-dialog.tsx"));
  if (!dialog || !deps.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const defaults = deps.sessionGroupDefaults(group);
  if (defaults) {
    await dialog.showSessionGroupDefaultsDialog({
      group,
      defaults,
      signal: scope.signal,
      listDirectory: (path) => {
        if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
          return Promise.reject(new Error(t("sessionsView.groupDefaultsStale")));
        }
        return deps.listSessionGroupFolders(path);
      },
      inspectRepository: (path) => {
        if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
          return Promise.reject(new Error(t("sessionsView.groupDefaultsStale")));
        }
        return deps.inspectSessionGroupRepository(path);
      },
      submit: async (nextDefaults) => {
        if (
          !deps.sessionData.isSessionMutationScopeCurrent(scope) ||
          !deps.sessionGroupDefaults(group)
        ) {
          return t("sessionsView.groupDefaultsStale");
        }
        const operations = await loadOperations(deps, scope);
        const result = await operations?.updateSessionGroupDefaults(
          deps,
          group,
          { cwd: nextDefaults.cwd || null, worktree: nextDefaults.worktree },
          scope,
        );
        return result === "completed"
          ? null
          : result === "stale"
            ? t("sessionsView.groupDefaultsStale")
            : (deps.sessionData.sessionMutationError ?? t("sessionsView.groupDefaultsFailed"));
      },
    });
  }
}
