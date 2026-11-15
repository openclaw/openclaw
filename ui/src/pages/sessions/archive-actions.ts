import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../../lib/sessions/session-key.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";

/** Page lifetime adapts to the same archive owner used by sidebar and chat. */
export function createSessionsArchive(host: {
  captureScope: (
    options?: Pick<SessionsPageRequestScope, "allowDeferred">,
  ) => SessionsPageRequestScope | null;
  clearError: () => void;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  publishError: (scope: SessionsPageRequestScope, error: unknown) => SessionsPageMutationResult;
  refresh: (scope: SessionsPageRequestScope) => Promise<unknown>;
  agentId: (key: string, context: ApplicationContext) => string | undefined;
}) {
  async function archive(
    row: GatewaySessionRow,
    hasDescendants = false,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = host.captureScope({ allowDeferred: true });
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
      return operations.archiveConfirmedSessionsWithUndo(
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
        choice.kind === "tree" ? choice.rows : [session],
        mutationScope,
      );
    } catch (error) {
      return host.publishError(scope, error);
    }
  }
  return { archive };
}
