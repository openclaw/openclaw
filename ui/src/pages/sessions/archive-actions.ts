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
export class SessionsPageArchive {
  constructor(private readonly host: SessionPageArchiveHost) {}

  private async loadOperations(scope: SessionsPageRequestScope) {
    try {
      return await import("../../components/session-organizer-archive.runtime.ts");
    } catch (error) {
      if (this.host.isCurrent(scope)) {
        this.host.publishError(scope, error);
      }
      return null;
    }
  }
  async archiveTree(row: GatewaySessionRow) {
    const scope = this.host.captureScope();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    if (!operations || !this.host.isCurrent(scope)) {
      return;
    }
    await operations.archiveSessionTreeWithUndo(
      {
        sessionData: {
          isSessionMutationScopeCurrent: () => this.host.isCurrent(scope),
          publishSessionMutationError: (_candidate, error) => {
            this.host.publishError(scope, error);
          },
          refreshSidebarSessions: async () => {
            await this.host.refresh(scope);
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
            agentId: this.host.agentId(key, scope.context),
          });
        },
        sidebarSessionStatusFilter: () => "all",
      },
      {
        key: row.key,
        agentId: row.agentId,
        sessionId: row.sessionId,
        label: row.label ?? row.displayName ?? row.key,
        pinned: row.pinned === true,
        archived: row.archived,
        category: row.category,
        sharingRole: row.sharingRole,
        active: false,
      },
      {
        ...scope,
        selectedAgentId: resolveUiSessionRowAgentId(
          row,
          scope.context.agentSelection.state.selectedId ??
            resolveUiDefaultAgentId({
              agentsList: scope.context.agents.state.agentsList,
              hello: scope.gateway.snapshot.hello,
            }),
        ),
      },
    );
  }

  async archive(row: GatewaySessionRow) {
    const scope = this.host.captureScope();
    if (!scope) {
      return;
    }
    const operations = await this.loadOperations(scope);
    if (!operations || !this.host.isCurrent(scope)) {
      return;
    }
    if (
      !(await operations.confirmRunningSessionsArchive(
        [{ ...row, label: row.label ?? row.displayName ?? row.key }],
        scope.signal,
      )) ||
      !this.host.isCurrent(scope)
    ) {
      return;
    }
    const onConfirmed = prepareArchiveOutcome(
      scope.sessions,
      row,
      this.host.agentId(row.key, scope.context),
    );
    if (!onConfirmed) {
      return;
    }
    const finishArchive = scope.sessions.beginArchive(row.key, row.sessionId);
    if (!finishArchive) {
      return;
    }
    try {
      await this.host.patch(row.key, { archived: true }, scope, row.sessionId, {
        onConfirmed,
        sessionScope: true,
      });
    } finally {
      finishArchive();
    }
  }
}
