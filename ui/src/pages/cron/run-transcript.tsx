import type { CronHistoryResult } from "@openclaw/gateway-protocol";
import { createMemo, flush } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronRunLogEntry } from "../../api/types.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { attachHistoryActivity } from "../chat/chat-history-request.ts";
import { mergeChatTranscriptPages } from "../chat/chat-transcript-pages.ts";
import { renderChatHistoryBoundary } from "../chat/components/chat-history-boundary.ts";
import { renderChatTranscriptFeed } from "../chat/components/chat-transcript-feed.ts";

type Scope = { client: GatewayBrowserClient; isCurrent: () => boolean };

/** The run log owns transcript identity; never resolve a client-selected session alias. */
export class CronRunTranscript {
  private attempt = 0;
  entry: CronRunLogEntry | null = null;
  private trigger: HTMLButtonElement | null = null;
  private scope: Scope | null = null;
  messages: unknown[] = [];
  nextCursor: string | undefined;
  private readonly cursors = new Set<string>();
  loading = false;
  error: string | null = null;
  failedCursor: string | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly notify: () => void,
    private readonly capture: () => Scope | null,
  ) {}

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
    this.notify();
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
    flush();
    if (this.entry !== entry || this.scope !== scope || !scope.isCurrent()) {
      return;
    }
    const region = this.host.querySelector<HTMLElement>("[data-cron-run-transcript]");
    region?.focus({ preventScroll: true });
    region?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  async load(cursor?: string) {
    const { entry, scope, attempt } = this;
    if (!entry || !scope || this.loading || !scope.isCurrent()) {
      return;
    }
    const current = () => this.attempt === attempt && this.host.isConnected && scope.isCurrent();
    this.loading = true;
    this.error = null;
    this.failedCursor = cursor;
    this.notify();
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
      this.notify();
    }
  }
}

export function CronRunTranscriptView(props: {
  controller: CronRunTranscript;
  revision: () => number;
}) {
  const state = () => {
    props.revision();
    return props.controller;
  };
  const transcript = createMemo(() => {
    const current = state();
    return [
      current.nextCursor
        ? renderChatHistoryBoundary({
            hasMore: true,
            loading: current.loading,
            onShowEarlier: () => void props.controller.load(props.controller.nextCursor),
          })
        : undefined,
      renderChatTranscriptFeed(current.messages),
    ];
  });
  return (
    <>
      {state().entry ? (
        <section
          class="card"
          role="region"
          tabindex="-1"
          aria-label={t("cron.runEntry.transcript")}
          data-cron-run-transcript
        >
          <div class="row">
            <h2>{t("cron.runEntry.transcript")}</h2>
            <button class="btn btn--sm" onClick={() => props.controller.close(true)}>
              {t("common.close")}
            </button>
          </div>
          {state().error ? (
            <>
              <p role="alert">{state().error}</p>
              <button
                class="btn btn--sm"
                disabled={state().loading}
                onClick={() => void props.controller.load(props.controller.failedCursor)}
              >
                {t("common.retry")}
              </button>
            </>
          ) : null}
          {state().loading ? <p role="status">{t("common.loading")}</p> : null}
          {!state().loading && !state().error && state().messages.length === 0 ? (
            <p>{t("cron.runEntry.transcriptEmpty")}</p>
          ) : null}
          <LitContent render={() => transcript()} />
        </section>
      ) : null}
    </>
  );
}
