import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionPatch, SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";

registerSessionOrganizationEnglish();

type SessionPageArchiveHost = {
  captureScope: () => SessionsPageRequestScope | null;
  clearError: () => void;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  publishError: (scope: SessionsPageRequestScope, error: unknown) => SessionsPageMutationResult;
  refresh: (scope: SessionsPageRequestScope) => Promise<unknown>;
  agentId: (key: string, context: ApplicationContext) => string | undefined;
  patch: (
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope,
    expectedSessionId: string | undefined,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean },
  ) => Promise<SessionsPageMutationResult>;
};

/** Page lifetime adapts to the same archive owner used by sidebar and chat. */
export function createSessionsArchive(host: SessionPageArchiveHost) {
  async function archive(
    row: GatewaySessionRow,
    hasDescendants = false,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = host.captureScope();
    if (!scope) {
      return;
    }
    host.clearError();
    try {
      const operations = await import("../../components/session-organizer-archive.runtime.ts");
      if (!host.isCurrent(scope)) {
        return "stale";
      }
      const session = {
        ...row,
        label: row.label ?? row.displayName ?? row.key,
        pinned: row.pinned === true,
        active: false,
        hasArchiveDescendants: hasDescendants,
      };
      const mutationScope = {
        ...scope,
        selectedAgentId: resolveUiSessionRowAgentId(
          row,
          scope.context.agentSelection.state.selectedId ??
            resolveUiDefaultAgentId({
              agentsList: scope.context.agents.state.agentsList,
              hello: scope.gateway.snapshot.hello,
            }),
        ),
      };
      const choice = await operations.confirmSessionArchive(session, mutationScope, () =>
        host.isCurrent(scope),
      );
      if (!choice) {
        return;
      }
      if (choice.kind === "tree") {
        return await operations.archiveConfirmedSessionsWithUndo(
          {
            sessionData: {
              isSessionMutationScopeCurrent: () => host.isCurrent(scope),
              publishSessionMutationError: (_candidate, error) => {
                host.publishError(scope, error);
              },
              refreshSidebarSessions: async () => {
                await host.refresh(scope);
              },
            },
            pruneSidebarSessionEntry: (key) => {
              scope.context.navigation.update({
                sidebarEntries: scope.context.navigation.snapshot.sidebarEntries.filter(
                  (entry) => entry !== "session:" + key,
                ),
              });
            },
            selectSession: (key) => {
              selectApplicationSession({
                selection: scope.context.agentSelection,
                gateway: scope.gateway,
                sessionKey: key,
                agentId: host.agentId(key, scope.context),
              });
            },
            sidebarSessionStatusFilter: () => "all",
          },
          choice.rows,
          mutationScope,
        );
      }
      const archiveSessions = scope.sessions;
      const archiveAgentId = host.agentId(row.key, scope.context);
      const { key, sessionId, pinned } = row;
      const connection = archiveSessions.captureConnectionScope();
      if (!connection) {
        return;
      }
      // Confirmation and Undo outlive the page, but keep the admitted connection and incarnation.
      const onConfirmed = (result: SessionPatchResult) => {
        if (
          !archiveSessions.isConnectionScopeCurrent(connection) ||
          result.entry.sessionId !== sessionId
        ) {
          return;
        }
        showToast({
          message: t("sessionsView.sessionArchived"),
          actionLabel: t("common.undo"),
          onAction: () => {
            if (!archiveSessions.isConnectionScopeCurrent(connection)) {
              return;
            }
            void archiveSessions
              .patch(
                key,
                { archived: false, ...(pinned === true ? { pinned: true } : {}) },
                { agentId: archiveAgentId, expectedSessionId: sessionId },
              )
              .catch((error: unknown) => {
                if (archiveSessions.isConnectionScopeCurrent(connection)) {
                  showToast({ message: formatUiError(error) });
                }
              });
          },
        });
      };
      const finishArchive = scope.sessions.beginArchive(row.key, row.sessionId);
      if (!finishArchive) {
        return;
      }
      try {
        return await host.patch(row.key, { archived: true }, scope, row.sessionId, {
          onConfirmed,
          sessionScope: true,
        });
      } finally {
        finishArchive();
      }
    } catch (error) {
      return host.publishError(scope, error);
    }
  }
  return { archive };
}
