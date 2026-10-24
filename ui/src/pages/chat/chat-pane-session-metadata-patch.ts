import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { resolveSidebarSessionParentKey } from "../../components/app-sidebar-session-parent.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
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

type HeaderMetadataAction = Extract<
  HeaderMenuAction,
  { kind: "toggle-unread" | "set-icon" | "set-color" | "set-communication" | "reset-appearance" }
>;

export function headerSessionMetadataPatch(
  action: HeaderMetadataAction,
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

function headerSessionActionRow(
  row: GatewaySessionRow,
  label: string,
  rows: readonly GatewaySessionRow[],
) {
  return {
    key: row.key,
    sessionId: row.sessionId,
    sharingRole: row.sharingRole,
    label,
    pinned: row.pinned === true,
    unread: row.unread === true,
    archived: row.archived === true,
    category: row.category,
    sidebarRoot: row.sidebarRoot,
    isChild:
      !isSubagentSessionKey(row.key) && Boolean(resolveSidebarSessionParentKey(row, new Set())),
    active: true,
    hasActiveRun: row.hasActiveRun ?? row.status === "running",
    gatewayHasActiveRun: row.hasActiveRun,
    hasActiveSubagentRun: row.hasActiveSubagentRun,
    hasArchiveDescendants: hasSessionArchiveDescendants(row, rows),
  };
}

export function createHeaderSessionActionRows(
  scope: SidebarSessionMutationScope,
  row: GatewaySessionRow,
  presentation: {
    label(row: GatewaySessionRow): string;
    rows(): readonly GatewaySessionRow[];
  },
) {
  const toActionSession = (candidate: GatewaySessionRow) =>
    headerSessionActionRow(candidate, presentation.label(candidate), presentation.rows());
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
  return { session, resolveCurrentSession };
}

export function createHeaderSessionActionHost(
  scope: SidebarSessionMutationScope,
  callbacks: {
    isCurrent(scope: SidebarSessionMutationScope): boolean;
    publishError(error: unknown): void;
    selectSession(key: string): void;
  },
): SessionOperations.SessionActionHost & { knownSessionGroups(): string[] } {
  return {
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
}

type HeaderSessionRenameAttempt = {
  scope: SidebarSessionMutationScope;
  isCurrent(): boolean;
  publishError(error: unknown): void;
};

/** The header supplies its live mutation owner; the organizer retains the dialog and operation. */
export async function renameSession(
  operations: Pick<typeof SessionOperations, "renameSession">,
  host: SessionOperations.SessionActionHost,
  row: GatewaySessionRow,
  scope: SidebarSessionMutationScope,
  draft: {
    state: ChatPageHost;
    signal: AbortSignal;
    begin(): HeaderSessionRenameAttempt | null;
  },
): Promise<void> {
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
    !draft.signal.aborted && candidate === attempt.scope && attempt.isCurrent();
  const renameHost: SessionOperations.SessionRenameHost = {
    ...host,
    sessionData: {
      ...host.sessionData,
      sessionDraftSignal: draft.signal,
      get sessionMutationError() {
        return draft.state.chatError;
      },
      beginSessionMutation: () => {
        if (draft.signal.aborted) {
          return null;
        }
        const next = draft.begin();
        if (!next) {
          return null;
        }
        // Renew request authority after reconnect without replacing the captured draft.
        attempt = next;
        draft.state.chatError = draft.state.lastError = null;
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
  await operations.renameSession(
    renameHost,
    {
      key: row.key,
      sessionId: row.sessionId,
      sharingRole: row.sharingRole,
      agentId: resolveChatAgentId(draft.state),
      label: row.label ?? "",
      renameValue: resolveSessionRenameValue(row),
      userLabel: row.label,
      pinned: row.pinned === true,
      active: true,
    },
    scope,
  );
}
