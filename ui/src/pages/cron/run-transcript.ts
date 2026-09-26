import type { CronHistoryResult } from "@openclaw/gateway-protocol";
import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronRunLogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { attachHistoryActivity } from "../chat/chat-history-request.ts";
import { mergeChatTranscriptPages } from "../chat/chat-transcript-pages.ts";
import { renderChatHistoryBoundary } from "../chat/components/chat-history-boundary.ts";
import { renderChatTranscriptFeed } from "../chat/components/chat-transcript-feed.ts";

type Scope = { client: GatewayBrowserClient; epoch: number; isCurrent: () => boolean };

/** The run log owns transcript identity; never resolve a client-selected session alias. */
export class CronRunTranscript implements ReactiveController {
  private attempt = 0;
  private entry: CronRunLogEntry | null = null;
  private trigger: HTMLButtonElement | null = null;
  private scope: Scope | null = null;
  private messages: unknown[] = [];
  private nextCursor: string | undefined;
  private readonly cursors = new Set<string>();
  private loading = false;
  private error: string | null = null;
  private failedCursor: string | undefined;

  constructor(
    private readonly host: HTMLElement & ReactiveControllerHost,
    private readonly capture: () => Scope | null,
  ) {
    host.addController(this);
  }

  hostDisconnected() {
    this.close();
  }

  close(restoreFocus = false) {
    const trigger = this.trigger;
    this.trigger = null;
    this.attempt++;
    this.entry = null;
    this.scope = null;
    this.messages = [];
    this.nextCursor = undefined;
    this.cursors.clear();
    this.loading = false;
    this.error = null;
    this.failedCursor = undefined;
    this.host.requestUpdate();
    if (restoreFocus && trigger?.isConnected) {
      trigger.focus();
    }
  }

  async open(entry: CronRunLogEntry, trigger: HTMLButtonElement) {
    this.close();
    const scope = this.capture();
    if (!scope) {
      return;
    }
    this.entry = entry;
    this.trigger = trigger;
    this.scope = scope;
    await this.load();
    if (this.entry !== entry || this.scope !== scope || !scope.isCurrent()) {
      return;
    }
    await this.host.updateComplete;
    if (this.entry !== entry || this.scope !== scope || !scope.isCurrent()) {
      return;
    }
    const region = this.host.querySelector<HTMLElement>("[data-cron-run-transcript]");
    region?.focus({ preventScroll: true });
    region?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  private async load(cursor?: string) {
    const { entry, scope, attempt } = this;
    if (!entry || !scope || this.loading || !scope.isCurrent()) {
      return;
    }
    const current = () => this.attempt === attempt && this.host.isConnected && scope.isCurrent();
    this.loading = true;
    this.error = null;
    this.failedCursor = cursor;
    this.host.requestUpdate();
    try {
      if (
        !entry.jobId ||
        (!entry.runId && (typeof entry.runAtMs !== "number" || !Number.isFinite(entry.runAtMs)))
      ) {
        throw new Error(t("cron.runEntry.transcriptMissingMetadata"));
      }
      const result = await scope.client.request<CronHistoryResult>("cron.history", {
        id: entry.jobId,
        ...(entry.runId ? { runId: entry.runId } : { runAtMs: entry.runAtMs }),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!current()) {
        return;
      }
      if (!Array.isArray(result.messages)) {
        throw new Error(t("cron.runEntry.transcriptUnavailable"));
      }
      const messages = visibleChatHistoryMessages(attachHistoryActivity(result).messages);
      if (cursor) {
        this.cursors.add(cursor);
      }
      this.messages = cursor
        ? mergeChatTranscriptPages(messages, this.messages).messages
        : messages;
      this.nextCursor =
        result.nextCursor && !this.cursors.has(result.nextCursor) ? result.nextCursor : undefined;
      this.failedCursor = undefined;
    } catch (error) {
      if (!current()) {
        return;
      }
      this.error = formatUiError(error, t("cron.runEntry.transcriptUnavailable"));
    }
    if (current()) {
      this.loading = false;
      this.host.requestUpdate();
    }
  }

  render() {
    if (!this.entry) {
      return nothing;
    }
    return html`<section
      class="card"
      role="region"
      tabindex="-1"
      aria-label=${t("cron.runEntry.transcript")}
      data-cron-run-transcript
    >
      <div class="row">
        <h2>${t("cron.runEntry.transcript")}</h2>
        <button class="btn btn--sm" @click=${() => this.close(true)}>${t("common.close")}</button>
      </div>
      ${
        this.error
          ? html`<p role="alert">${this.error}</p>
              <button
                class="btn btn--sm"
                ?disabled=${this.loading}
                @click=${() => void this.load(this.failedCursor)}
              >
                ${t("common.retry")}
              </button>`
          : nothing
      }
      ${this.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
      ${
        this.nextCursor
          ? renderChatHistoryBoundary({
              hasMore: true,
              loading: this.loading,
              onShowEarlier: () => void this.load(this.nextCursor),
            })
          : nothing
      }
      ${!this.loading && !this.error && this.messages.length === 0 ? html`<p>${t("cron.runEntry.transcriptEmpty")}</p>` : nothing}
      ${renderChatTranscriptFeed(this.messages)}
    </section>`;
  }
}
