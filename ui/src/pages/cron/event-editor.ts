import type { ApplicationContext } from "../../app/context.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import { validateCronForm } from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createCronEventSource, type CronEventSourceView } from "./event-source.ts";

type CronEventEditorDependencies = {
  currentCronState: () => CronState;
  context: () => ApplicationContext;
  canManage: () => boolean;
  isConnected: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  notify: () => void;
};

// The editor owns discovery scope and form refresh; the source owns
// catalog and diagnostics requests within that scope.
export function createCronEventEditor(deps: CronEventEditorDependencies) {
  const source = createCronEventSource(() => deps.notify());
  let scopeKey = "";

  function reset() {
    source.reset();
    scopeKey = "";
  }

  function available() {
    return (
      canCallGatewayMethod(deps.context().gateway.snapshot, "mcp.events.list", "operator.admin") &&
      canCallGatewayMethod(deps.context().gateway.snapshot, "mcp-events.status", "operator.admin")
    );
  }

  function view(): CronEventSourceView {
    const cron = deps.currentCronState();
    const canDiscover = available();
    const active =
      Boolean(cron.cronCreateOpen || cron.cronEditingJob) &&
      cron.cronForm.scheduleKind === "event" &&
      cron.cronForm.eventSource === "mcp-events" &&
      deps.isConnected() &&
      canDiscover;
    return {
      available: canDiscover,
      servers: active
        ? (
            summarizeMcpServers(
              deps.context().runtimeConfig.state.configSnapshot?.config ?? null,
            ) ?? []
          )
            .filter((server) => server.enabled)
            .map((server) => server.name)
        : [],
      loading: source.loading,
      error: source.error,
      events: source.events,
      subscriptions: source.subscriptions,
      statusError: source.statusError,
      onRefresh: () => {
        deps.currentCronState().cronFieldErrors = validateCronForm(
          deps.currentCronState().cronForm,
        );
        sync(true);
      },
    };
  }

  function sync(force = false) {
    const cron = deps.currentCronState();
    const form = cron.cronForm;
    const connection = deps.captureConnection();
    const active =
      (cron.cronCreateOpen || cron.cronEditingJob) &&
      form.scheduleKind === "event" &&
      form.eventSource === "mcp-events";
    if (!active || !deps.isConnected() || !connection || !available()) {
      if (force || scopeKey) {
        reset();
      }
      return;
    }
    const agentId = form.agentId.trim() || deps.context().agentSelection.state.selectedId || "main";
    const serverName = form.eventServer;
    const editingJob = cron.cronEditingJob;
    const sourceIdentity = editingJob?.state.sourceIdentity;
    const jobRevision = editingJob?.configRevision;
    const jobEnabled = editingJob?.enabled;
    const key = JSON.stringify([
      agentId,
      serverName,
      editingJob?.id,
      jobRevision,
      sourceIdentity,
      jobEnabled,
    ]);
    if (!force && key === scopeKey) {
      return;
    }
    scopeKey = key;
    if (deps.canManage()) {
      void deps.context().runtimeConfig.ensureLoaded();
    }
    void source.load({
      client: connection.client,
      agentId,
      serverName,
      jobId: editingJob?.id,
      sourceIdentity,
      isCurrent: () =>
        // Scope hydration can change the selected agent without replacing CronState.
        // Recheck live editor fields before publishing, not only after the next render.
        (cron.cronForm.agentId.trim() ||
          deps.context().agentSelection.state.selectedId ||
          "main") === agentId &&
        cron.cronEditingJob?.id === editingJob?.id &&
        cron.cronEditingJob?.configRevision === jobRevision &&
        cron.cronEditingJob?.enabled === jobEnabled &&
        cron.cronEditingJob?.state.sourceIdentity === sourceIdentity &&
        cron.cronForm.eventServer === serverName &&
        cron.cronForm.scheduleKind === "event" &&
        cron.cronForm.eventSource === "mcp-events" &&
        (cron.cronCreateOpen || Boolean(cron.cronEditingJob)) &&
        deps.isConnected() &&
        deps.currentCronState() === cron &&
        scopeKey === key &&
        deps.isCurrentConnection(connection) &&
        available(),
    });
  }
  return {
    reset,
    sync,
    get view() {
      return view();
    },
  };
}
