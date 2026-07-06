import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import {
  applyTaskEvent,
  mergeTaskLists,
  normalizeTasksCancelResult,
  normalizeTasksListResult,
  type TaskSummary,
} from "./data.ts";
import { renderTasks } from "./view.ts";

function formatTaskError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return typeof error === "string" && error.trim() ? error.trim() : fallback;
}

export class TasksPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private tasks: TaskSummary[] = [];
  @state() private connected = false;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private cancellingTaskIds = new Set<string>();

  private client: GatewayBrowserClient | null = null;
  private loadGeneration = 0;
  private stopGatewaySubscription?: () => void;
  private stopGatewayEvents?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.stopGatewaySubscription = this.context.gateway.subscribe(() => {
      const wasConnected = this.connected;
      const previousClient = this.client;
      this.syncGatewayState();
      if (this.connected && (this.client !== previousClient || !wasConnected)) {
        void this.refreshTasks();
      }
    });
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      if (event.event !== "task") {
        return;
      }
      const result = applyTaskEvent(this.tasks, event.payload);
      if (result.refetch) {
        void this.refreshTasks();
        return;
      }
      this.tasks = result.tasks;
    });
    if (this.connected) {
      void this.refreshTasks();
    }
  }

  override disconnectedCallback() {
    this.loadGeneration += 1;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    if (this.client !== gateway.client) {
      this.loadGeneration += 1;
      this.client = gateway.client;
      this.tasks = [];
      this.loading = false;
      this.error = null;
      this.cancellingTaskIds = new Set();
    }
    this.connected = gateway.connected;
  }

  private async refreshTasks() {
    const client = this.client;
    if (!this.connected || !client) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.error = null;
    try {
      // Active tasks need their own query: the ledger pages newest-first, so a
      // long-running task can hide behind newer terminal records on page one.
      const [activePayload, recentPayload] = await Promise.all([
        client.request("tasks.list", { status: ["queued", "running"], limit: 500 }),
        client.request("tasks.list", { limit: 200 }),
      ]);
      const active = normalizeTasksListResult(activePayload);
      const recent = normalizeTasksListResult(recentPayload);
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      const tasks = mergeTaskLists(recent, active);
      if (generation === this.loadGeneration && client === this.client) {
        this.tasks = tasks;
      }
    } catch (error) {
      if (generation === this.loadGeneration && client === this.client) {
        this.error = formatTaskError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      if (generation === this.loadGeneration && client === this.client) {
        this.loading = false;
      }
    }
  }

  private async cancelTask(taskId: string) {
    const client = this.client;
    if (!this.connected || !client || this.cancellingTaskIds.has(taskId)) {
      return;
    }
    this.cancellingTaskIds = new Set([...this.cancellingTaskIds, taskId]);
    this.error = null;
    try {
      const payload = await client.request("tasks.cancel", { taskId });
      const result = normalizeTasksCancelResult(payload);
      if (result?.task) {
        this.tasks = applyTaskEvent(this.tasks, { action: "upserted", task: result.task }).tasks;
      }
      // Refusals (already terminal, stale id, no cancellation handle) are
      // successful responses with cancelled=false; surface them like errors.
      if (!result?.cancelled) {
        this.error = result?.reason?.trim() || t("tasksPage.cancelFailed");
      }
    } catch (error) {
      this.error = formatTaskError(error, t("tasksPage.cancelFailed"));
    } finally {
      const next = new Set(this.cancellingTaskIds);
      next.delete(taskId);
      this.cancellingTaskIds = next;
    }
  }

  override render() {
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("tasks")}</div>
          <div class="page-sub">${subtitleForRoute("tasks")}</div>
        </div>
        <button
          class="btn"
          type="button"
          ?disabled=${!this.connected || this.loading}
          @click=${() => void this.refreshTasks()}
        >
          ${this.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </section>
      ${renderTasks({
        basePath: this.context.basePath,
        connected: this.connected,
        // tasks.cancel needs operator.write; read-only operators get no button.
        canCancel: hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        loading: this.loading,
        error: this.error,
        tasks: this.tasks,
        cancellingTaskIds: this.cancellingTaskIds,
        onCancel: (taskId) => void this.cancelTask(taskId),
        onNavigateToChat: (sessionKey) =>
          this.context.navigate("chat", { search: searchForSession(sessionKey) }),
      })}
    `;
  }
}

if (!customElements.get("openclaw-tasks-page")) {
  customElements.define("openclaw-tasks-page", TasksPage);
}
