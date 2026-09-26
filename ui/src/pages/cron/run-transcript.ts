import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronRunLogEntry } from "../../api/types.ts";
import "../../styles/chat/sidebar.css";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  normalizeTaskEventPayload,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  taskTitle,
} from "../../lib/tasks/data.ts";
import type { TaskSummary } from "../../lib/tasks/task-summary.ts";
import {
  observeTaskDetailEvent,
  resetTaskDetail,
  type TaskTranscriptHost,
} from "../chat/components/chat-task-detail-state.ts";
import { renderTaskTranscript } from "../chat/components/chat-task-detail.ts";

type Scope = { client: GatewayBrowserClient; epoch: number; isCurrent: () => boolean };

export class CronRunTranscript implements ReactiveController {
  private attempt = 0;
  private entry: CronRunLogEntry | null = null;
  private task: TaskSummary | null = null;
  private candidateId: string | null = null;
  private error: string | null = null;
  private readonly transcript: TaskTranscriptHost = {
    client: null,
    connected: false,
    requestUpdate: () => this.host.requestUpdate(),
  };

  constructor(
    private readonly host: HTMLElement & ReactiveControllerHost,
    private readonly capture: () => Scope | null,
  ) {
    host.addController(this);
  }

  hostDisconnected() {
    this.close();
  }

  close() {
    this.attempt++;
    resetTaskDetail(this.transcript);
    this.entry = null;
    this.task = null;
    this.candidateId = null;
    this.error = null;
    this.host.requestUpdate();
  }

  observe(payload: unknown) {
    const event = normalizeTaskEventPayload(payload);
    if (!event) {
      return;
    }
    if (
      event.action === "deleted" &&
      (event.taskId === this.task?.id || event.taskId === this.candidateId)
    ) {
      this.close();
      return;
    }
    observeTaskDetailEvent(this.transcript, event);
  }

  async open(entry: CronRunLogEntry) {
    this.close();
    const scope = this.capture();
    if (!scope) {
      return;
    }
    this.entry = entry;
    const attempt = this.attempt;
    const current = () => attempt === this.attempt && this.host.isConnected && scope.isCurrent();
    const matches = (task: TaskSummary) =>
      task.runtime === "cron" &&
      task.sourceId === entry.jobId &&
      task.childSessionKey === entry.sessionKey &&
      task.startedAt === entry.runAtMs;
    try {
      if (
        !entry.jobId ||
        !entry.sessionKey?.trim() ||
        typeof entry.runAtMs !== "number" ||
        !Number.isFinite(entry.runAtMs)
      ) {
        throw new Error(t("cron.runEntry.transcriptMissingMetadata"));
      }
      const matchesById = new Map<string, TaskSummary>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = normalizeTasksListResult(
          await scope.client.request("tasks.list", {
            sessionKey: entry.sessionKey,
            limit: 500,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!current()) {
          return;
        }
        if (!result) {
          throw new Error(t("tasksPage.invalidResponse"));
        }
        for (const task of result.tasks) {
          if (matches(task)) {
            matchesById.set(task.id, task);
          }
        }
        cursor = result.nextCursor;
        if (cursor) {
          if (cursors.has(cursor)) {
            throw new Error(t("tasksPage.invalidResponse"));
          }
          cursors.add(cursor);
        }
      } while (cursor);
      const [task] = matchesById.values();
      if (matchesById.size !== 1 || !task) {
        throw new Error(t("cron.runEntry.transcriptUnavailable"));
      }
      this.candidateId = task.id;
      const fresh = normalizeTasksGetResult(
        await scope.client.request("tasks.get", { taskId: task.id }),
      );
      if (!current()) {
        return;
      }
      if (!fresh || fresh.id !== task.id || !matches(fresh) || !fresh.hasTranscript) {
        throw new Error(t("cron.runEntry.transcriptUnavailable"));
      }
      this.task = fresh;
      Object.assign(this.transcript, {
        client: scope.client,
        connected: true,
        connectionEpoch: scope.epoch,
      });
    } catch (error) {
      if (!current()) {
        return;
      }
      this.error = formatUiError(error, t("tasksPage.loadFailed"));
    }
    if (!current()) {
      return;
    }
    this.host.requestUpdate();
    await this.host.updateComplete;
    if (!current()) {
      return;
    }
    const region = this.host.querySelector<HTMLElement>("[data-cron-run-transcript]");
    region?.focus({ preventScroll: true });
    region?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  render() {
    if (!this.entry) {
      return nothing;
    }
    return html`<section
      class="card"
      role="region"
      tabindex="-1"
      aria-label=${t("tasksPage.transcript")}
      data-cron-run-transcript
    >
      <div class="row">
        <h2>${this.task ? taskTitle(this.task) : t("tasksPage.transcript")}</h2>
        <button class="btn btn--sm" @click=${() => this.close()}>${t("common.close")}</button>
      </div>
      ${
        this.error
          ? html`<p role="alert">${this.error}</p>
              <button class="btn btn--sm" @click=${() => this.entry && void this.open(this.entry)}>
                ${t("common.retry")}
              </button>`
          : this.task
            ? renderTaskTranscript({ host: this.transcript, task: this.task })
            : html`<p role="status">${t("tasksPage.loading")}</p>`
      }
    </section>`;
  }
}
