import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionPatch, SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import { prepareArchiveOutcome } from "./archive-outcome.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";

type SessionPageArchiveHost = {
  captureScope: () => SessionsPageRequestScope | null;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  publishError: (scope: SessionsPageRequestScope, error: unknown) => unknown;
  refresh: (scope: SessionsPageRequestScope) => Promise<unknown>;
  agentId: (key: string, context: ApplicationContext) => string | undefined;
  patch: (
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope,
    expectedSessionId: string | undefined,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean },
  ) => Promise<unknown>;
};

/** Page lifetime adapts to the same archive owner used by sidebar and chat. */
export function createSessionsArchive(host: SessionPageArchiveHost) {
  async function loadOperations(scope: SessionsPageRequestScope) {
    try {
      return await import("../../components/session-organizer-archive.runtime.ts");
    } catch (error) {
      if (host.isCurrent(scope)) {
        host.publishError(scope, error);
      }
      return null;
    }
  }
  async function archive(row: GatewaySessionRow, hasDescendants = false) {
    const scope = host.captureScope();
    if (!scope) {
      return;
    }
    const operations = await loadOperations(scope);
    if (!operations || !host.isCurrent(scope)) {
      return;
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
    let choice: Awaited<ReturnType<typeof operations.confirmSessionArchive>>;
    try {
      choice = await operations.confirmSessionArchive(session, mutationScope, () =>
        host.isCurrent(scope),
      );
    } catch (error) {
      if (host.isCurrent(scope)) {
        host.publishError(scope, error);
      }
      return;
    }
    if (!choice) {
      return;
    }
    if (choice.kind === "tree") {
      await operations.archiveConfirmedSessionsWithUndo(
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
      return;
    }
    const onConfirmed = prepareArchiveOutcome(
      scope.sessions,
      row,
      host.agentId(row.key, scope.context),
    );
    if (!onConfirmed) {
      return;
    }
    const finishArchive = scope.sessions.beginArchive(row.key, row.sessionId);
    if (!finishArchive) {
      return;
    }
    try {
      await host.patch(row.key, { archived: true }, scope, row.sessionId, {
        onConfirmed,
        sessionScope: true,
      });
    } finally {
      finishArchive();
    }
  }
  return { archive };
}
