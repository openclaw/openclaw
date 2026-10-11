import type { ApplicationContext } from "../../app/context.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";
import { validateCronForm } from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { CronEventSourceController, type CronEventSourceView } from "./event-source.ts";

type CronEventEditorHost = {
  currentCronState: () => CronState;
  context: () => ApplicationContext;
  canManage: () => boolean;
  isConnected: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  notify: () => void;
};

// The editor owns discovery scope and form refresh; the source controller owns
// the catalog and diagnostics requests within that scope.
export class CronEventEditorController {
  private readonly source = new CronEventSourceController(() => this.host.notify());
  private scopeKey = "";

  constructor(private readonly host: CronEventEditorHost) {}

  reset() {
    this.source.reset();
    this.scopeKey = "";
  }

  private get available() {
    return (
      canCallGatewayMethod(
        this.host.context().gateway.snapshot,
        "mcp.events.list",
        "operator.admin",
      ) &&
      canCallGatewayMethod(
        this.host.context().gateway.snapshot,
        "mcp-events.status",
        "operator.admin",
      )
    );
  }

  get view(): CronEventSourceView {
    return {
      available: this.available,
      servers: (
        summarizeMcpServers(
          this.host.context().runtimeConfig.state.configSnapshot?.config ?? null,
        ) ?? []
      )
        .filter((server) => server.enabled)
        .map((server) => server.name),
      loading: this.source.loading,
      error: this.source.error,
      events: this.source.events,
      subscriptions: this.source.subscriptions,
      statusError: this.source.statusError,
      onRefresh: () => {
        this.host.currentCronState().cronFieldErrors = validateCronForm(
          this.host.currentCronState().cronForm,
        );
        this.sync(true);
      },
    };
  }

  sync(force = false) {
    const cron = this.host.currentCronState();
    const form = cron.cronForm;
    const connection = this.host.captureConnection();
    const active =
      (cron.cronCreateOpen || cron.cronEditingJob) &&
      form.scheduleKind === "event" &&
      form.eventSource === "mcp-events";
    if (!active || !this.available) {
      if (force || this.scopeKey) {
        this.reset();
      }
      return;
    }
    const agentId =
      form.agentId.trim() || this.host.context().agentSelection.state.selectedId || "main";
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
    if (!force && key === this.scopeKey) {
      return;
    }
    this.scopeKey = key;
    this.source.reset();
    if (!connection) {
      return;
    }
    if (this.host.canManage()) {
      void this.host.context().runtimeConfig.ensureLoaded();
    }
    void this.source.load({
      client: connection.client,
      agentId,
      serverName,
      jobId: editingJob?.id,
      sourceIdentity,
      isCurrent: () =>
        // Scope hydration can change the selected agent without replacing CronState.
        // Recheck live editor fields before publishing, not only after the next render.
        (cron.cronForm.agentId.trim() ||
          this.host.context().agentSelection.state.selectedId ||
          "main") === agentId &&
        cron.cronEditingJob?.id === editingJob?.id &&
        cron.cronEditingJob?.configRevision === jobRevision &&
        cron.cronEditingJob?.enabled === jobEnabled &&
        cron.cronEditingJob?.state.sourceIdentity === sourceIdentity &&
        cron.cronForm.eventServer === serverName &&
        cron.cronForm.scheduleKind === "event" &&
        cron.cronForm.eventSource === "mcp-events" &&
        (cron.cronCreateOpen || Boolean(cron.cronEditingJob)) &&
        this.host.isConnected() &&
        this.host.currentCronState() === cron &&
        this.scopeKey === key &&
        this.host.isCurrentConnection(connection) &&
        this.available,
    });
  }
}
