import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { i18n } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import "../../styles/logbook.css";
import {
  askLogbook,
  configureLogbookPolling,
  getLogbookState,
  loadLogbook,
  loadLogbookFramePreview,
  loadLogbookStandup,
  localDayKey,
  runLogbookAnalysisNow,
  setLogbookCapturePaused,
  shiftDay,
} from "./logbook-controller.ts";
import type { LogbookCardPayload, LogbookStatusPayload } from "./logbook-types.ts";

export type LogbookProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
};
type LogbookControllerState = ReturnType<typeof getLogbookState>;

/** Stable category hue so colors stay consistent across renders and days. */
function categoryHue(category: string): number {
  let hash = 0;
  for (let i = 0; i < category.length; i += 1) {
    hash = (hash * 31 + category.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function StatusChips(props: { status: LogbookStatusPayload }) {
  const chip = (content: JSX.Element, kind = "", title?: string) => (
    <span class={["logbook__chip", kind && `logbook__chip--${kind}`]} title={title}>
      {content}
    </span>
  );
  return (
    <div class="logbook__chips">
      <span
        class={[
          "logbook__chip",
          {
            "logbook__chip--ok":
              props.status.captureEnabled &&
              !props.status.capturePaused &&
              !props.status.lastCaptureError,
            "logbook__chip--warn":
              !props.status.captureEnabled ||
              props.status.capturePaused ||
              Boolean(props.status.lastCaptureError),
          },
        ]}
      >
        <span class="logbook__chip-dot" />
        {props.status.capturePaused
          ? t("logbook.status.paused")
          : props.status.captureEnabled
            ? t("logbook.status.capturing", {
                seconds: String(props.status.captureIntervalSeconds),
              })
            : t("logbook.status.disabled")}
      </span>
      <Show when={props.status.nodeName || props.status.nodeId}>
        {chip(
          <>
            <Icon name="monitor" /> {props.status.nodeName ?? props.status.nodeId}
          </>,
          "",
          t("logbook.status.nodeHelp"),
        )}
      </Show>
      <Show when={props.status.pendingFrames > 0}>
        {chip(
          t("logbook.status.pending", { count: String(props.status.pendingFrames) }),
          "",
          t("logbook.status.pendingHelp"),
        )}
      </Show>
      <Show when={props.status.analysisRunning}>{chip(t("logbook.status.analyzing"), "busy")}</Show>
      <Show when={props.status.lastCaptureError}>
        {chip(
          t("logbook.status.captureError"),
          "error",
          formatUiExternalText(props.status.lastCaptureError),
        )}
      </Show>
      <Show when={props.status.lastBatch?.status === "error"}>
        {chip(
          t("logbook.status.batchError"),
          "error",
          formatUiExternalText(props.status.lastBatch?.error),
        )}
      </Show>
      <Show when={props.status.visionModelSource === "missing"}>
        {chip(t("logbook.status.modelMissing"), "warn", t("logbook.status.modelMissingHelp"))}
      </Show>
    </div>
  );
}

function LogbookCard(props: {
  state: () => LogbookControllerState;
  client: GatewayBrowserClient | null;
  card: LogbookCardPayload;
  timeZone: string;
  formatClock: (ms: number, timeZone: string) => string;
}) {
  const expanded = () => props.state().expandedCardIds.has(props.card.id);
  // Pruned keyframes remain absent rather than retrying on every render.
  const keyframeId = () =>
    props.card.keyframeId !== undefined &&
    !props.state().framePreviewFailed.has(props.card.keyframeId)
      ? props.card.keyframeId
      : undefined;
  const preview = () =>
    keyframeId() !== undefined ? props.state().framePreviews.get(keyframeId()!) : undefined;
  createEffect(
    () => ({
      expanded: expanded(),
      id: keyframeId(),
      preview: preview(),
      state: props.state(),
      client: props.client,
    }),
    (current) => {
      if (current.expanded && current.id !== undefined && !current.preview) {
        void loadLogbookFramePreview(current.state, current.client, current.id);
      }
    },
  );
  return (
    <article
      class={["logbook-card", { "logbook-card--expanded": expanded() }]}
      style={{ "--logbook-hue": categoryHue(props.card.category) }}
    >
      <button
        class="logbook-card__header"
        type="button"
        onClick={() => {
          const next = new Set(props.state().expandedCardIds);
          if (expanded()) {
            next.delete(props.card.id);
          } else {
            next.add(props.card.id);
          }
          props.state().expandedCardIds = next;
          props.state().requestUpdate?.();
        }}
      >
        <span class="logbook-card__time">
          {props.formatClock(props.card.startMs, props.timeZone)}
          <span class="logbook-card__time-sep">–</span>
          {props.formatClock(props.card.endMs, props.timeZone)}
        </span>
        <span class="logbook-card__stripe" aria-hidden="true" />
        <span class="logbook-card__heading">
          <span class="logbook-card__title">{props.card.title}</span>
          <span class="logbook-card__summary">{props.card.summary}</span>
        </span>
        <span class="logbook-card__meta">
          <span class="logbook-card__category">{props.card.category}</span>
          <Show when={props.card.appPrimary}>
            <span class="logbook-card__app">{props.card.appPrimary}</span>
          </Show>
          <span class="logbook-card__duration">
            {formatDurationCompact(props.card.endMs - props.card.startMs) ?? "0s"}
          </span>
        </span>
      </button>
      <Show when={expanded()}>
        <div class="logbook-card__body">
          <Show
            when={preview()}
            fallback={
              <Show when={keyframeId() !== undefined}>
                <div class="logbook-card__keyframe logbook-card__keyframe--loading">
                  {t("common.loading")}
                </div>
              </Show>
            }
          >
            {(src) => (
              <img class="logbook-card__keyframe" src={src()} alt={t("logbook.card.keyframeAlt")} />
            )}
          </Show>
          <Show when={props.card.detail}>
            <p class="logbook-card__detail">{formatUiExternalText(props.card.detail)}</p>
          </Show>
          <Show when={props.card.distractions.length > 0}>
            <div class="logbook-card__distractions">
              <span class="logbook-card__distractions-label">{t("logbook.card.distractions")}</span>
              <For each={props.card.distractions} keyed={false}>
                {(distraction) => (
                  <span class="logbook-card__distraction">
                    {props.formatClock(distraction().startMs, props.timeZone)} ·{" "}
                    {distraction().title}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </article>
  );
}

function Stats(props: { state: () => LogbookControllerState }) {
  const stats = () => props.state().timeline?.stats;
  const focusPct = () =>
    Math.round(
      (Math.max(0, stats()!.trackedMs - stats()!.distractionMs) / stats()!.trackedMs) * 100,
    );
  return (
    <Show when={stats() && stats()!.trackedMs > 0}>
      <section class="card logbook-side__card">
        <div class="card-title">{t("logbook.stats.title")}</div>
        <div class="logbook-stats__focus">
          <div class="logbook-stats__focus-bar">
            <div class="logbook-stats__focus-fill" style={{ width: `${focusPct()}%` }} />
          </div>
          <div class="logbook-stats__focus-legend">
            <span>{t("logbook.stats.focus", { pct: String(focusPct()) })}</span>
            <span>
              {t("logbook.stats.tracked", {
                duration: formatDurationCompact(stats()!.trackedMs) ?? "0s",
              })}
            </span>
          </div>
        </div>
        <div class="logbook-stats__categories">
          <For each={stats()!.categories.slice(0, 6)} keyed={false}>
            {(entry) => (
              <div
                class="logbook-stats__category"
                style={{ "--logbook-hue": categoryHue(entry().category) }}
              >
                <span class="logbook-stats__category-name">{entry().category}</span>
                <span class="logbook-stats__category-bar">
                  <span
                    class="logbook-stats__category-fill"
                    style={{
                      width: `${Math.max(6, Math.round((entry().ms / (stats()!.categories[0]?.ms ?? 1)) * 100))}%`,
                    }}
                  />
                </span>
                <span class="logbook-stats__category-time">
                  {formatDurationCompact(entry().ms) ?? "0s"}
                </span>
              </div>
            )}
          </For>
        </div>
        <Show when={stats()!.apps.length > 0}>
          <div class="logbook-stats__apps">
            <For each={stats()!.apps.slice(0, 5)} keyed={false}>
              {(app) => <span class="logbook-stats__app">{app().domain}</span>}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

function Standup(props: {
  state: () => LogbookControllerState;
  client: GatewayBrowserClient | null;
}) {
  return (
    <section class="card logbook-side__card">
      <div class="logbook-side__card-header">
        <div class="card-title">{t("logbook.standup.title")}</div>
        <button
          class="btn btn--small"
          type="button"
          disabled={props.state().standupLoading}
          onClick={() =>
            void loadLogbookStandup(props.state(), props.client, props.state().standup !== null)
          }
        >
          {props.state().standupLoading
            ? t("common.loading")
            : props.state().standup
              ? t("logbook.standup.refresh")
              : t("logbook.standup.generate")}
        </button>
      </div>
      <Show
        when={props.state().standup}
        fallback={<div class="card-sub">{t("logbook.standup.empty")}</div>}
      >
        {(standup) => (
          <SanitizedHtml
            tag="div"
            class="logbook-standup__body markdown-body"
            html={toSanitizedMarkdownHtml(standup().text)}
          />
        )}
      </Show>
    </section>
  );
}

function Ask(props: { state: () => LogbookControllerState; client: GatewayBrowserClient | null }) {
  return (
    <section class="card logbook-side__card">
      <div class="card-title">{t("logbook.ask.title")}</div>
      <form
        class="logbook-ask__form"
        onSubmit={(event) => {
          event.preventDefault();
          void askLogbook(props.state(), props.client);
        }}
      >
        <input
          class="logbook-ask__input"
          type="text"
          value={props.state().askQuestion}
          placeholder={t("logbook.ask.placeholder")}
          onInput={(event) => {
            props.state().askQuestion = event.currentTarget.value;
          }}
        />
        <button class="btn btn--small" type="submit" disabled={props.state().askLoading}>
          {props.state().askLoading ? t("common.loading") : t("logbook.ask.submit")}
        </button>
      </form>
      <Show when={props.state().askAnswer}>
        <p class="logbook-ask__answer">{props.state().askAnswer}</p>
      </Show>
    </section>
  );
}

export function Logbook(props: LogbookProps) {
  const locale = projectI18n(i18n);
  const formatClock = (ms: number, timeZone: string) => {
    locale.locale();
    return formatTimeMs(ms, { hour: "2-digit", minute: "2-digit", timeZone }, "");
  };
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = () => {
    revision();
    return getLogbookState(props.host);
  };
  createEffect(
    () => ({ host: props.host, client: props.client, connected: props.connected }),
    (current) => {
      const currentState = getLogbookState(current.host);
      currentState.requestUpdate = () => setRevision((value) => value + 1);
      configureLogbookPolling(currentState, current.connected ? current.client : null);
      if (
        current.connected &&
        !currentState.timeline &&
        !currentState.loading &&
        !currentState.error
      ) {
        void loadLogbook(currentState, current.client);
      }
      return () => {
        currentState.requestUpdate = null;
        configureLogbookPolling(currentState, null);
      };
    },
  );
  const isToday = () => state().day === (state().status?.today ?? localDayKey());
  const button = (content: JSX.Element, onClick: () => void, disabled = false, label?: string) => (
    <button
      class="btn btn--small"
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {content}
    </button>
  );
  return (
    <section class="logbook">
      <header class="logbook__header">
        <div class="logbook__daynav">
          {button(
            "‹",
            () => void loadLogbook(state(), props.client, { day: shiftDay(state().day, -1) }),
            false,
            t("logbook.nav.previousDay"),
          )}
          <span class="logbook__day">{state().day}</span>
          {button(
            "›",
            () => void loadLogbook(state(), props.client, { day: shiftDay(state().day, 1) }),
            isToday(),
            t("logbook.nav.nextDay"),
          )}
          <Show when={!isToday()}>
            {button(
              t("logbook.nav.today"),
              () => void loadLogbook(state(), props.client, { today: true }),
            )}
          </Show>
        </div>
        <Show when={state().status}>{(status) => <StatusChips status={status()} />}</Show>
        <div class="logbook__actions">
          <Show when={state().status}>
            {(status) => (
              <button
                class="btn btn--small"
                type="button"
                disabled={state().actionPending || !status().captureEnabled}
                onClick={() =>
                  void setLogbookCapturePaused(
                    state(),
                    props.client,
                    !state().status?.capturePaused,
                  )
                }
              >
                {t(status().capturePaused ? "logbook.actions.resume" : "logbook.actions.pause")}
              </button>
            )}
          </Show>
          {button(
            t("logbook.actions.analyzeNow"),
            () => void runLogbookAnalysisNow(state(), props.client),
            state().actionPending,
          )}
          {button(
            <Icon name="refresh" />,
            () => void loadLogbook(state(), props.client),
            state().loading,
          )}
        </div>
      </header>
      <Show when={state().error}>
        <div class="callout danger" role="alert">
          {state().error}
        </div>
      </Show>
      <div class="logbook__layout">
        <div class="logbook__timeline">
          <Show when={state().loading && (state().timeline?.cards.length ?? 0) === 0}>
            <div class="card-sub">{t("common.loading")}</div>
          </Show>
          <Show
            when={!state().loading && (state().timeline?.cards.length ?? 0) === 0 && !state().error}
          >
            <div class="logbook__empty">
              <div class="logbook__empty-title">{t("logbook.empty.title")}</div>
              <div class="logbook__empty-sub">{t("logbook.empty.subtitle")}</div>
            </div>
          </Show>
          <Show when={state().status}>
            <For each={state().timeline?.cards ?? []} keyed={(card) => card.id}>
              {(card) => (
                <LogbookCard
                  state={state}
                  client={props.client}
                  card={card()}
                  timeZone={state().status!.timeZone}
                  formatClock={formatClock}
                />
              )}
            </For>
          </Show>
        </div>
        <aside class="logbook__side">
          <Stats state={state} />
          <Standup state={state} client={props.client} />
          <Ask state={state} client={props.client} />
        </aside>
      </div>
    </section>
  );
}
