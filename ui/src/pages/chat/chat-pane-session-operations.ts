import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { resolveSidebarSessionParentKey } from "../../components/app-sidebar-session-parent.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "../../components/app-sidebar-session-types.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import type * as SessionOperations from "../../components/session-organizer-operations.runtime.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionRenameValue } from "../../lib/session-rename.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";

function headerSessionMetadataPatch(
  action: Extract<
    HeaderMenuAction,
    { kind: "toggle-unread" | "set-icon" | "set-color" | "set-communication" | "reset-appearance" }
  >,
  session: Pick<GatewaySessionRow, "unread">,
) {
  switch (action.kind) {
    case "toggle-unread":
      return { unread: !session.unread };
    case "set-icon":
      return { icon: action.icon };
    case "set-color":
      return { color: action.color };
    case "set-communication":
      return { communication: action.communication };
    case "reset-appearance":
      return { icon: null, color: null };
  }
  return action satisfies never;
}

type HeaderSessionRenameAttempt = {
  scope: SidebarSessionMutationScope;
  isCurrent(): boolean;
  publishError(error: unknown): void;
};

type HeaderSessionOperation = Exclude<
  HeaderMenuAction,
  {
    kind:
      | "move-session"
      | "stop-cloud-worker"
      | "open-in"
      | "copy-session-id"
      | "copy-session-link"
      | "copy-session-preview-link"
      | "copy-markdown"
      | "open-new-tab"
      | "open-new-window"
      | "split-right"
      | "split-below"
      | "continue-in-terminal"
      | "toggle-pin"
      | "new-group"
      | "plugin";
  }
>;

export async function runHeaderSessionOperation(
  action: HeaderSessionOperation,
  row: GatewaySessionRow,
  scope: SidebarSessionMutationScope,
  callbacks: {
    isCurrent(scope: SidebarSessionMutationScope): boolean;
    publishError(error: unknown): void;
    selectSession(key: string): void;
    label(row: GatewaySessionRow): string;
    rows(): readonly GatewaySessionRow[];
    state(): ChatPageHost | undefined;
    draftSignal: AbortSignal;
    beginRename(state: ChatPageHost): {
      scope: SidebarSessionMutationScope;
      isCurrent(): boolean;
      publishError(error: unknown): void;
    } | null;
  },
): Promise<SidebarSessionMutationResult | void> {
  if (!callbacks.isCurrent(scope)) {
    return;
  }
  const toActionSession = (actionRow: GatewaySessionRow) => {
    const label = callbacks.label(actionRow);
    const rows = callbacks.rows();
    return {
      key: actionRow.key,
      sessionId: actionRow.sessionId,
      sharingRole: actionRow.sharingRole,
      label,
      pinned: actionRow.pinned === true,
      unread: actionRow.unread === true,
      archived: actionRow.archived === true,
      category: actionRow.category,
      sidebarRoot: actionRow.sidebarRoot,
      isChild:
        !isSubagentSessionKey(actionRow.key) &&
        Boolean(resolveSidebarSessionParentKey(actionRow, new Set())),
      active: true,
      hasActiveRun: actionRow.hasActiveRun ?? actionRow.status === "running",
      gatewayHasActiveRun: actionRow.hasActiveRun,
      hasActiveSubagentRun: actionRow.hasActiveSubagentRun,
      hasArchiveDescendants: hasSessionArchiveDescendants(actionRow, rows),
      hasAutomation: actionRow.hasAutomation === true,
    };
  };
  const session = toActionSession(row);
  // Refresh metadata only on the selected instance. Replacements retain the
  // captured ID so the Gateway rejects them; no-ID rows still need roster presence.
  const resolveCurrentSession = (notify = false) => {
    const currentRow = scope.sessions.state.result?.sessions.find(
      (candidate) =>
        areUiSessionKeysEquivalent(candidate.key, row.key) &&
        (!session.sessionId || candidate.sessionId === session.sessionId),
    );
    const resolvedRow = currentRow ?? (session.sessionId ? row : null);
    if (!resolvedRow && notify) {
      showToast({ message: t("common.refresh") });
    }
    return resolvedRow ? toActionSession(resolvedRow) : null;
  };
  const {
    archiveSessionWithUndo,
    assignSessionCategory,
    assignSessionOwner,
    deleteSession,
    forkSession,
    patchSession,
    promoteSession,
    renameSession,
    setSessionInvolvement,
    snoozeSessionWithUndo,
  } = await import("../../components/session-organizer-operations.runtime.ts");
  if (!callbacks.isCurrent(scope)) {
    return;
  }
  const host: SessionOperations.SessionActionHost & { knownSessionGroups(): string[] } = {
    sessionData: {
      isSessionMutationScopeCurrent: (candidate) => callbacks.isCurrent(candidate),
      publishSessionMutationError: (candidate, error) => {
        if (callbacks.isCurrent(candidate)) {
          callbacks.publishError(error);
        }
      },
      refreshSidebarSessions: async (agentId) => {
        const outcome = await scope.sessions.reconcileMutation(agentId);
        if (outcome.status === "failed" && callbacks.isCurrent(scope)) {
          callbacks.publishError(outcome.error);
        }
      },
    },
    pruneSidebarSessionEntry: (key) => {
      const entry = serializeSidebarEntry({ type: "session", key });
      const sidebarEntries = scope.context.navigation.snapshot.sidebarEntries.filter(
        (candidate) => candidate !== entry,
      );
      scope.context.navigation.update({ sidebarEntries });
    },
    selectSession: (key) => callbacks.selectSession(key),
    sidebarSessionStatusFilter: () => "active",
    knownSessionGroups: () =>
      collectKnownSessionGroups(
        scope.sessions.state.groups,
        scope.sessions.state.result?.sessions ?? [],
      ),
  };
  const draftSignal = callbacks.draftSignal;
  const assignCategory = (category: string | null) =>
    assignSessionCategory(host, session, category, scope, {
      resolveSession: resolveCurrentSession,
    });
  switch (action.kind) {
    // Header supplies live mutation authority; the organizer retains the draft and operation.
    case "rename": {
      const state = callbacks.state();
      if (!state) {
        return;
      }
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      const access = readSessionMethodAccess(scope.gateway.snapshot, {
        method: "sessions.patch",
        params: { key: row.key, label: null },
        sessionScope: true,
        session: row,
        allowDeferred: true,
      });
      if (!access.allowed) {
        host.sessionData.publishSessionMutationError(scope, access.reason);
        return;
      }
      let attempt: HeaderSessionRenameAttempt = {
        scope,
        isCurrent: () => host.sessionData.isSessionMutationScopeCurrent(scope),
        publishError: (error) => host.sessionData.publishSessionMutationError(scope, error),
      };
      const isCurrent = (candidate: SidebarSessionMutationScope) =>
        !draftSignal.aborted && candidate === attempt.scope && attempt.isCurrent();
      const renameHost: SessionOperations.SessionRenameHost = {
        ...host,
        sessionData: {
          ...host.sessionData,
          sessionDraftSignal: draftSignal,
          get sessionMutationError() {
            return state.chatError;
          },
          beginSessionMutation: () => {
            if (draftSignal.aborted) {
              return null;
            }
            const next = callbacks.beginRename(state);
            if (!next) {
              return null;
            }
            // Renew request authority after reconnect without replacing the captured draft.
            attempt = next;
            state.chatError = state.lastError = null;
            return next.scope;
          },
          isSessionMutationScopeCurrent: isCurrent,
          publishSessionMutationError: (candidate, error) => {
            if (isCurrent(candidate)) {
              attempt.publishError(error);
            }
          },
        },
      };
      await renameSession(
        renameHost,
        {
          key: row.key,
          sessionId: row.sessionId,
          sharingRole: row.sharingRole,
          agentId: resolveChatAgentId(state),
          label: row.label ?? "",
          renameValue: resolveSessionRenameValue(row),
          userLabel: row.label,
          pinned: row.pinned === true,
          active: true,
        },
        scope,
      );
      return;
    }
    case "toggle-involving-me":
      await setSessionInvolvement(host, session, !row.hiddenFromInvolvingMe, scope);
      break;
    case "toggle-unread":
    case "set-icon":
    case "set-color":
    case "set-communication":
    case "reset-appearance": {
      const currentSession = resolveCurrentSession(true);
      if (currentSession) {
        const patch = headerSessionMetadataPatch(action, currentSession);
        await patchSession(host, currentSession, patch, scope, {
          sessionScope: action.kind === "toggle-unread",
        });
      }
      break;
    }
    case "assign-owner":
      await assignSessionOwner(host, session, action.owner, scope);
      break;
    case "fork":
      await forkSession(host, session, scope);
      break;
    case "move-to-top-level":
      await promoteSession(host, session, scope);
      break;
    case "move-to-group":
      return await assignCategory(action.category);
    case "snooze":
      await snoozeSessionWithUndo(host, session, action, scope);
      break;
    case "wake":
      await patchSession(host, session, { snoozedUntil: null }, scope, {
        sessionScope: true,
      });
      break;
    case "toggle-archived":
      if (session.archived) {
        await patchSession(host, session, { archived: false }, scope, {
          sessionScope: true,
        });
      } else {
        await archiveSessionWithUndo(host, session, scope);
      }
      break;
    case "delete":
      await deleteSession(host, session, scope);
      break;
    default:
      action satisfies never;
  }
}
