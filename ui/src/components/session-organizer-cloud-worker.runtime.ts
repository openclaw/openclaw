import { t } from "../i18n/index.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { requestCloudWorkerStop } from "./cloud-worker-stop.runtime.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { requireSessionMutationAccess } from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

export async function stopCloudWorker(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  const stopAction = session.cloudWorkerStopAction;
  // The Gateway revalidates placement and run state after confirmation.
  if (!stopAction || (stopAction.blocksActiveRun && session.hasActiveRun)) {
    return;
  }
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.stopCloudWorkerConfirm", { session: session.label }),
    confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
    danger: true,
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.stopCloudWorkerStale", { session: session.label }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  if (!requireSessionMutationAccess(host, scope, stopAction)) {
    return;
  }
  try {
    const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
    await requestCloudWorkerStop(
      scope.client,
      {
        key: session.key,
        agentId,
      },
      scope.context.placementStartup,
    );
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    const outcome = await scope.sessions.reconcileMutation(agentId);
    if (outcome.status === "failed" && host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, outcome.error);
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}
