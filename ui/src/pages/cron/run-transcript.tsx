import type { CronHistoryResult } from "@openclaw/gateway-protocol";
import { onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronRunLogEntry } from "../../api/types.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { attachHistoryActivity } from "../chat/chat-history-request.ts";
import { mergeChatTranscriptPages } from "../chat/chat-transcript-pages.ts";
import { ChatHistoryBoundary } from "../chat/components/chat-history-boundary.tsx";
import { ChatTranscriptFeed } from "../chat/components/chat-transcript-feed-view.tsx";

type Scope = { client: GatewayBrowserClient; isCurrent: () => boolean };

/** The run log owns transcript identity; never resolve a client-selected session alias. */
export function createCronRunTranscript(notify: () => void, capture: () => Scope | null) {
  let attempt = 0;
  let trigger: HTMLButtonElement | null = null;
  let scope: Scope | null = null;
  let region: HTMLElement | undefined;
  const cursors = new Set<string>();
  const state: {
    entry: CronRunLogEntry | null;
    messages: unknown[];
    nextCursor?: string;
    loading: boolean;
    error: string | null;
    failedCursor?: string;
  } = { entry: null, messages: [], loading: false, error: null };
  function close(restoreFocus = false) {
    const previousTrigger = trigger;
    trigger = null;
    attempt++;
    state.entry = null;
    scope = null;
    state.messages = [];
    state.nextCursor = undefined;
    cursors.clear();
    state.loading = false;
    state.error = null;
    state.failedCursor = undefined;
    notify();
    if (restoreFocus && previousTrigger?.isConnected) {
      previousTrigger.focus();
    }
  }

  async function open(entry: CronRunLogEntry, button: HTMLButtonElement) {
    close();
    const captured = capture();
    if (!captured) {
      return;
    }
    state.entry = entry;
    trigger = button;
    scope = captured;
    await load();
    onSettled(() => {
      if (state.entry !== entry || scope !== captured || !captured.isCurrent()) {
        return;
      }
      region?.focus({ preventScroll: true });
      region?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }

  async function load(cursor?: string) {
    const { entry } = state;
    const captured = scope;
    const request = attempt;
    if (!entry || !captured || state.loading || !captured.isCurrent()) {
      return;
    }
    const current = () => attempt === request && captured.isCurrent();
    state.loading = true;
    state.error = null;
    state.failedCursor = cursor;
    notify();
    try {
      if (!entry.runId && entry.runAtMs === undefined) {
        throw new Error(t("cron.runEntry.transcriptMissingMetadata"));
      }
      const result = await captured.client.request<CronHistoryResult>("cron.history", {
        id: entry.jobId,
        ...(entry.runId ? { runId: entry.runId } : { runAtMs: entry.runAtMs }),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!current()) {
        return;
      }
      const messages = visibleChatHistoryMessages(attachHistoryActivity(result).messages);
      if (cursor) {
        cursors.add(cursor);
      }
      state.messages = cursor ? mergeChatTranscriptPages(messages, state.messages) : messages;
      state.nextCursor =
        result.nextCursor && !cursors.has(result.nextCursor) ? result.nextCursor : undefined;
      state.failedCursor = undefined;
    } catch (error) {
      if (!current()) {
        return;
      }
      state.error = formatUiError(error, t("cron.runEntry.transcriptUnavailable"));
    }
    if (current()) {
      state.loading = false;
      notify();
    }
  }
  return Object.assign(state, {
    close,
    open,
    load,
    reconnect() {
      const interrupted = state.loading;
      attempt += 1;
      scope = capture();
      state.loading = false;
      if (state.entry && scope && (interrupted || state.messages.length === 0)) {
        void load(state.failedCursor);
      }
    },
    ref: (element: HTMLElement) => {
      region = element;
    },
  });
}

export function CronRunTranscriptView(props: {
  transcript: ReturnType<typeof createCronRunTranscript>;
  revision: () => number;
}) {
  const state = () => {
    props.revision();
    return props.transcript;
  };

  return (
    <>
      {state().entry ? (
        <section
          ref={(element) => props.transcript.ref(element)}
          class="card"
          role="region"
          tabindex="-1"
          aria-label={t("cron.runEntry.transcript")}
          data-cron-run-transcript
        >
          <div class="row">
            <h2>{t("cron.runEntry.transcript")}</h2>
            <button class="btn btn--sm" onClick={() => props.transcript.close(true)}>
              {t("common.close")}
            </button>
          </div>
          {state().error ? (
            <>
              <p role="alert">{state().error}</p>
              <button
                class="btn btn--sm"
                disabled={state().loading}
                onClick={() => void props.transcript.load(props.transcript.failedCursor)}
              >
                {t("common.retry")}
              </button>
            </>
          ) : null}
          {state().loading ? <p role="status">{t("common.loading")}</p> : null}
          {!state().loading && !state().error && state().messages.length === 0 ? (
            <p>{t("cron.runEntry.transcriptEmpty")}</p>
          ) : null}
          {state().nextCursor ? (
            <ChatHistoryBoundary
              hasMore={true}
              loading={state().loading}
              onShowEarlier={() => void props.transcript.load(props.transcript.nextCursor)}
            />
          ) : undefined}
          <ChatTranscriptFeed messages={state().messages} />
        </section>
      ) : null}
    </>
  );
}
