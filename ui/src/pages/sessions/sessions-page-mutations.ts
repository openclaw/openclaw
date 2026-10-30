import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  confirmWithBoundAutomations,
  reportAutomationCleanupOutcome,
  withBoundAutomationNotice,
} from "../../components/session-automation-confirm.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "../../components/session-workspace-recovery.runtime.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccessRequest,
} from "../../lib/session-method-access.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import {
  isSessionDeferredPatch,
  type SessionPatch,
  type SessionPatchResult,
} from "../../lib/sessions/patch.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import type {
  SessionDeleteTarget,
  SessionListOptions,
} from "../../lib/sessions/session-capability.ts";
import { resolveUiSessionRowAgentId } from "../../lib/sessions/session-key.ts";
import { formatPreservedWorktreesNotice } from "../../lib/sessions/worktree-preservation.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import { sessionAgentId, sessionPathAgentId } from "./agent-scope.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import { settleSelectedSession, type SessionDeleteRow } from "./selection.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

type SessionsPageMutationHost = {
  application: ApplicationContext;
  state: SessionsPageState;
  captureScope: (
    options?: Pick<SessionsPageRequestScope, "allowDeferred">,
  ) => SessionsPageRequestScope | null;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  refresh: (scope: SessionsPageRequestScope) => Promise<void>;
  listOptions: (context: ApplicationContext) => SessionListOptions;
  reconcile: () => void;
  onDeleted: (
    scope: SessionsPageRequestScope,
    requests: SessionDeleteTarget[],
    deleted: string[],
  ) => void;
};

/** Commands retain the page's synchronous scope authority and settlement policy. */
export function createSessionsPageMutations(host: SessionsPageMutationHost) {
  const {
    application,
    state,
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    refresh: refreshSessionList,
    listOptions: sessionListOptions,
  } = host;
  let pending = false;
  const sessionMutations = {
    get pending() {
      return pending;
    },
    retire() {
      pending = false;
    },
    async run(
      scope: SessionsPageRequestScope,
      mutate: () => Promise<SessionsPageMutationResult | void>,
    ): Promise<SessionsPageMutationResult | void> {
      state.error = null;
      pending = true;
      let outcome: SessionsPageMutationResult | void = undefined;
      try {
        outcome = await mutate();
      } catch (error) {
        outcome = { status: "failed", error };
      } finally {
        if (isRequestScopeCurrent(scope)) {
          pending = false;
          host.reconcile();
          if (outcome && typeof outcome === "object") {
            state.error = outcome.error;
          }
        }
      }
      return isRequestScopeCurrent(scope) ? outcome : "stale";
    },
  };

  function publishRequestError(
    scope: SessionsPageRequestScope,
    error: unknown,
  ): SessionsPageMutationResult {
    if (!isRequestScopeCurrent(scope)) {
      return "stale";
    }
    state.error = error;
    return { status: "failed", error };
  }

  function mutationDisabledReason(request: SessionMethodAccessRequest): string | undefined {
    const access = readSessionMethodAccess(application.gateway.snapshot, request);
    return access.allowed ? undefined : access.reason;
  }

  function mutationAccessError(
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ): string | null {
    const access = readSessionMethodAccess(scope.gateway.snapshot, request);
    if (access.allowed) {
      return null;
    }
    state.error = access.reason;
    return access.reason;
  }

  function selectedDeleteDisabledReason(): string | undefined {
    for (const row of state.selectedSessions.values()) {
      const reason = mutationDisabledReason({
        method: "sessions.delete",
        allowDeferred: true,
        params: {
          key: row.key,
          ...(row.archived === true ? { archivedOnly: true } : {}),
        },
      });
      if (reason) {
        return reason;
      }
    }
    return undefined;
  }

  async function deleteSelected() {
    const rows = [...state.selectedSessions.values()];
    if (rows.length === 0 || state.loading || sessionMutations.pending) {
      return;
    }
    const scope = captureRequestScope({ allowDeferred: true });
    if (!scope) {
      return;
    }
    const message = t(
      rows.length === 1
        ? "sessionsView.deleteSelectedConfirmOne"
        : "sessionsView.deleteSelectedConfirm",
      { count: String(rows.length) },
    );
    if (!(await confirmDelete(message, rows, scope)) || !isRequestScopeCurrent(scope)) {
      return;
    }
    return deleteSessions(rows.filter((row) => state.selectedSessions.get(row.key) === row));
  }

  // Selections keep captured row copies across same-incarnation refreshes;
  // automation facts come from the roster row for that incarnation when present.
  function currentAutomationFlag(row: SessionDeleteRow): boolean | undefined {
    const current = state.result?.sessions.find(
      (entry) => entry.key === row.key && entry.sessionId === row.sessionId,
    );
    return (current ?? row).hasAutomation;
  }

  // Bound automations turn the delete confirm into an explicit pause warning.
  function confirmDelete(
    message: string,
    rows: readonly SessionDeleteRow[],
    scope: SessionsPageRequestScope,
  ) {
    const options = {
      message,
      confirmLabel: t("common.delete"),
      danger: true,
      signal: scope.signal,
    };
    return confirmWithBoundAutomations(
      {
        action: "delete",
        sessions: rows.map((row) => ({
          key: row.key,
          agentId: sessionAgentId(row.key, scope.context),
          label: normalizeOptionalString(row.label) ?? row.key,
          hasAutomation: currentAutomationFlag(row),
        })),
        gateway: scope.gateway,
        signal: scope.signal,
      },
      (notice) => showConfirmDialog(notice ? withBoundAutomationNotice(options, notice) : options),
      Boolean,
    );
  }

  function confirmMutation(
    message: string,
    options: { confirmLabel?: string; signal?: AbortSignal } = {},
  ) {
    return showConfirmDialog({
      message,
      confirmLabel: t("common.delete"),
      danger: true,
      ...options,
    });
  }

  async function deleteSessions(
    rows: SessionDeleteRow[],
    options: { deleteTranscript?: boolean } = {},
  ) {
    if (rows.length === 0 || state.loading || sessionMutations.pending) {
      return;
    }
    const scope = captureRequestScope({ allowDeferred: true });
    if (!scope) {
      return;
    }
    const requests = rows.map((row) => ({
      key: row.key,
      agentId: sessionAgentId(row.key, scope.context),
      ...options,
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.archived === true ? { archivedOnly: true } : {}),
    }));
    for (const params of requests) {
      if (mutationAccessError(scope, { method: "sessions.delete", params, allowDeferred: true })) {
        return;
      }
    }
    return sessionMutations.run(scope, async () => {
      const request = async () => {
        const result = await scope.sessions.deleteMany(requests);
        if (rows.length === 1 && result.errors.length > 0) {
          throw result.errors[0]!.error;
        }
        return result;
      };
      const row = rows[0]!;
      const result =
        rows.length === 1
          ? await withSessionWorkspaceRecovery({
              action: "delete",
              session: {
                ...row,
                label: row.label || row.displayName || row.key,
                agentId: requests[0]!.agentId,
              },
              scope,
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (!isRequestScopeCurrent(scope) || !result) {
        return undefined;
      }
      if (result.preservedWorktrees.length > 0) {
        window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
      }
      if (result.deleted.length > 0) {
        host.onDeleted(scope, requests, result.deleted);
      }
      await refreshSessionList(scope);
      const errors = result.errors.map(({ error }) => formatBatchSessionRemovalError(error));
      reportAutomationCleanupOutcome(result.automationCleanup, (message) => errors.push(message));
      return errors.length > 0
        ? {
            status: "failed",
            error: errors.join("; "),
          }
        : "completed";
    });
  }

  async function deleteAllArchived() {
    const scope = captureRequestScope();
    if (!scope || state.loading || sessionMutations.pending) {
      return;
    }
    // The rendered list is bounded by the page's limit filter; re-enumerate the
    // full archived set so "all archived" means all of them. Any abnormal page
    // (failure, non-advancing offset) aborts: deleting a partial enumeration
    // would silently violate the "all archived" contract.
    let rows: GatewaySessionRow[];
    try {
      // One options snapshot for every page: filter edits made while pages load
      // must not mix populations; a deep link never narrows "all archived".
      const {
        search: _deepLinkSearch,
        agentId: _linkedAgentId,
        ...filters
      } = sessionListOptions(scope.context);
      const agentId = scope.context.agentSelection.state.scopeId?.trim();
      const listOptions = { ...filters, ...(agentId ? { agentId } : {}) };
      const listed = await fetchPagedSessionRows({
        list: (offset) => scope.sessions.list({ ...listOptions, limit: 1000, offset }),
        isCurrent: () => isRequestScopeCurrent(scope),
        missingResultError: "archived session enumeration returned no result",
        stalledPaginationError: "archived session enumeration did not advance",
        incompletePaginationError: "archived session enumeration was incomplete",
      });
      if (!listed) {
        return;
      }
      rows = listed;
    } catch (error) {
      return publishRequestError(scope, error);
    }
    const archivedRows = rows.filter((row) => row.archived === true);
    if (archivedRows.length === 0) {
      return;
    }
    if (
      !(await confirmMutation(
        t("sessionsView.deleteAllArchivedConfirm", {
          count: String(archivedRows.length),
        }),
        { signal: scope.signal },
      )) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    return deleteSessions(archivedRows, { deleteTranscript: true });
  }

  async function deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const scope = captureRequestScope({ allowDeferred: true });
    if (
      !scope ||
      !(await confirmDelete(
        t("sessionsView.deleteSessionConfirm", { session: label }),
        [row],
        scope,
      )) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    return deleteSessions([row]);
  }

  async function stopCloudWorker(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const stopAction = resolveCloudWorkerStopAction(row.placement);
    if (!stopAction || (stopAction.blocksActiveRun && row.hasActiveRun === true)) {
      return;
    }
    const scope = captureRequestScope();
    if (
      !scope ||
      !(await confirmMutation(t("sessionsView.stopCloudWorkerConfirm", { session: label }), {
        confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
        signal: scope.signal,
      })) ||
      !isRequestScopeCurrent(scope) ||
      mutationAccessError(scope, stopAction)
    ) {
      return;
    }
    return sessionMutations.run(scope, async () => {
      const agentId = resolveUiSessionRowAgentId(row, sessionPathAgentId(row.key, scope.context));
      await requestCloudWorkerStop(
        scope.client,
        {
          key: row.key,
          ...(agentId ? { agentId } : {}),
        },
        scope.context.placementStartup,
      );
      if (isRequestScopeCurrent(scope)) {
        await refreshSessionList(scope);
      }
      return "completed";
    });
  }

  async function patchSession(
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope | null = captureRequestScope({
      allowDeferred: isSessionDeferredPatch(patch),
    }),
    expectedSessionId?: string,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean } = {},
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      // Nothing was attempted (e.g. rename dialog submitted after the gateway
      // dropped); say so instead of silently swallowing the edit.
      state.error = t("sessionsView.actionRequiresConnection");
      return { status: "failed", error: t("sessionsView.actionRequiresConnection") };
    }
    if (typeof patch.archived === "boolean" && !expectedSessionId?.trim()) {
      state.error = "Session lifecycle action requires a durable session identity.";
      return {
        status: "failed",
        error: "Session lifecycle action requires a durable session identity.",
      };
    }
    const agentId = sessionAgentId(key, scope.context);
    const row = state.result?.sessions.find((entry) => entry.key === key);
    const accessError = mutationAccessError(scope, {
      method: "sessions.patch",
      allowDeferred: scope.allowDeferred && isSessionDeferredPatch(patch),
      sessionScope: options.sessionScope,
      session: row,
      params: {
        key,
        ...patch,
        ...(agentId ? { agentId } : {}),
      },
    });
    if (accessError) {
      return { status: "failed", error: accessError };
    }
    state.error = null;
    try {
      const request = () =>
        scope.sessions.patch(key, patch, {
          agentId,
          ...(expectedSessionId ? { expectedSessionId } : {}),
          ...(options.onConfirmed ? { onConfirmed: options.onConfirmed } : {}),
        });
      const patched =
        patch.archived === true
          ? await withSessionWorkspaceRecovery({
              action: "archive",
              session: {
                key,
                sessionId: expectedSessionId,
                label: row?.label || row?.displayName || key,
                agentId,
              },
              scope,
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        return "stale";
      }
      if ("queued" in patched) {
        return "completed";
      }
      await refreshSessionList(scope);
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      const selected = state.selectedSessions;
      state.selectedSessions = settleSelectedSession(selected, key, patched.entry.sessionId);
      return "completed";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }

  async function forkSession(
    key: string,
    fromLastCompleted = false,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = sessionAgentId(key, scope.context);
    const createParams = {
      parentSessionKey: key,
      fork: true,
      ...(fromLastCompleted ? { forkFrom: "last-completed" as const } : {}),
      ...(agentId ? { agentId } : {}),
    };
    if (
      mutationAccessError(scope, {
        method: "sessions.create",
        params: createParams,
        sessionScope: true,
        session: state.result?.sessions.find((row) => row.key === key),
      })
    ) {
      return;
    }
    state.error = null;
    try {
      const forked = await scope.sessions.createResult(createParams, { signal: scope.signal });
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (forked) {
        const forkedKey = forked.key;
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: forkedKey,
            agentId: agentId ?? sessionPathAgentId(forkedKey, scope.context),
          }).options,
          hash: "",
        });
      }
      return forked ? "completed" : "stale";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }

  async function runPluginAction(
    id: string,
    target: Pick<GatewaySessionRow, "key" | "sessionId">,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    state.error = null;
    try {
      await runControlUiPluginAction({
        runtime: scope.context.plugins,
        id,
        placement: "session",
        sessionKey: target.key,
        session: state.result?.sessions.find(
          (row) => row.key === target.key && row.sessionId === target.sessionId,
        ),
        signal: scope.signal,
        isCurrent: () => isRequestScopeCurrent(scope),
      });
      return isRequestScopeCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }
  function assignOwner(
    row: GatewaySessionRow,
    owner: Parameters<ApplicationContext["sessions"]["assignOwner"]>[1],
  ): Promise<SessionsPageMutationResult | void> | void {
    const scope = captureRequestScope();
    if (!scope) {
      state.error = t("sessionsView.actionRequiresConnection");
      return;
    }
    if (
      mutationAccessError(scope, {
        method: "sessions.assignOwner",
        params: { key: row.key, owner },
        requiredScope: "operator.write",
      })
    ) {
      return;
    }
    return sessionMutations.run(scope, async () => {
      const assigned = await scope.sessions.assignOwner(row.key, owner);
      return assigned ? "completed" : "stale";
    });
  }

  return {
    deleteSelected,
    deleteAllArchived,
    deleteSessionFromMenu,
    stopCloudWorker,
    patchSession,
    forkSession,
    runPluginAction,
    assignOwner,
    accessError: mutationAccessError,
    disabledReason: mutationDisabledReason,
    selectedDeleteDisabledReason,
    publishError: publishRequestError,
    retire: () => sessionMutations.retire(),
  };
}
