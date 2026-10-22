import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerLogbookEnglish } from "../../i18n/locales/en-logbook.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { projectI18n, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../styles/logbook.css";
import { createLogbookActions, type LogbookActions } from "./logbook-actions.ts";
import { createLogbook, localDayKey, shiftDay, type LogbookModel } from "./logbook-state.ts";
import type { LogbookCardPayload, LogbookStatusPayload, LogbookUiState } from "./logbook-types.ts";

registerEnglishCatalog(registerLogbookEnglish);

export type LogbookProps = {
  initialClient: GatewayBrowserClient | null;
  // Return the same promise until the route or connection lifetime retires.
  getRetired: () => Promise<void>;
};

/** Stable category hue so colors stay consistent across renders and days. */
function categoryHue(category: string): number {
  let hash = 0;
  for (let i = 0; i < category.length; i += 1) {
    hash = (hash * 31 + category.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function StatusChip(props: { children: JSX.Element; kind?: string; title?: string }) {
  return (
    <span
      class={["logbook__chip", props.kind && `logbook__chip--${props.kind}`]}
      title={props.title}
    >
      {props.children}
    </span>
  );
}

function ActionButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button class="btn btn--small" type="button" {...props} />;
}

function StatusChips(props: { status: LogbookStatusPayload }) {
  return (
    <div class="logbook__chips">
      <StatusChip
        kind={
          props.status.captureEnabled &&
          !props.status.capturePaused &&
          !props.status.lastCaptureError
            ? "ok"
            : "warn"
        }
      >
        <span class="logbook__chip-dot" />
        {props.status.capturePaused
          ? t("logbook.status.paused")
          : props.status.captureEnabled
            ? t("logbook.status.capturing", {
                seconds: String(props.status.captureIntervalSeconds),
              })
            : t("logbook.status.disabled")}
      </StatusChip>
      <Show when={props.status.nodeName || props.status.nodeId}>
        <StatusChip title={t("logbook.status.nodeHelp")}>
          <Icon name="monitor" /> {props.status.nodeName ?? props.status.nodeId}
        </StatusChip>
      </Show>
      <Show when={props.status.pendingFrames > 0}>
        <StatusChip title={t("logbook.status.pendingHelp")}>
          {t("logbook.status.pending", { count: String(props.status.pendingFrames) })}
        </StatusChip>
      </Show>
      <Show when={props.status.analysisRunning}>
        <StatusChip kind="busy">{t("logbook.status.analyzing")}</StatusChip>
      </Show>
      <Show when={props.status.lastCaptureError}>
        <StatusChip kind="error" title={formatUiExternalText(props.status.lastCaptureError)}>
          {t("logbook.status.captureError")}
        </StatusChip>
      </Show>
      <Show when={props.status.lastBatch?.status === "error"}>
        <StatusChip kind="error" title={formatUiExternalText(props.status.lastBatch?.error)}>
          {t("logbook.status.batchError")}
        </StatusChip>
      </Show>
      <Show when={props.status.visionModelSource === "missing"}>
        <StatusChip kind="warn" title={t("logbook.status.modelMissingHelp")}>
          {t("logbook.status.modelMissing")}
        </StatusChip>
      </Show>
    </div>
  );
}

function LogbookKeyframe(props: { model: LogbookModel; id: number }) {
  // An expanded image keeps its decoded source when the bounded shared cache evicts it.
  const preview = createMemo<string | undefined>(
    (previous) => props.model.state.framePreviews.get(props.id) ?? previous,
  );
  onSettled(() => {
    if (!preview()) {
      void props.model.loadFrame(props.id);
    }
  });
  return (
    <Show
      when={preview()}
      fallback={
        <div class="logbook-card__keyframe logbook-card__keyframe--loading">
          {t("common.loading")}
        </div>
      }
    >
      {(src) => (
        <img class="logbook-card__keyframe" src={src()} alt={t("logbook.card.keyframeAlt")} />
      )}
    </Show>
  );
}

function LogbookCard(props: {
  model: LogbookModel;
  card: LogbookCardPayload;
  timeZone: string;
  formatClock: (ms: number, timeZone: string) => string;
}) {
  const [expanded, setExpanded] = createSignal(false);
  // Pruned keyframes remain absent rather than retrying on every render.
  const keyframeId = () =>
    props.card.keyframeId !== undefined &&
    !props.model.state.framePreviewFailed.has(props.card.keyframeId)
      ? props.card.keyframeId
      : undefined;
  return (
    <article
      class={["logbook-card", { "logbook-card--expanded": expanded() }]}
      style={{ "--logbook-hue": categoryHue(props.card.category) }}
    >
      <button class="logbook-card__header" type="button" onClick={() => setExpanded(!expanded())}>
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
          <For each={keyframeId() === undefined ? [] : [keyframeId()!]}>
            {(id) => <LogbookKeyframe model={props.model} id={id} />}
          </For>
          <Show when={props.card.detail}>
            <p class="logbook-card__detail">{props.card.detail.trim()}</p>
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

function Stats(props: { state: () => LogbookUiState }) {
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

function Standup(props: { model: LogbookModel; actions: LogbookActions }) {
  return (
    <section class="card logbook-side__card">
      <div class="logbook-side__card-header">
        <div class="card-title">{t("logbook.standup.title")}</div>
        <ActionButton
          disabled={props.actions.standupPending() || props.model.state.standupLoading}
          onClick={() => void props.actions.createStandup(props.actions.standup() !== null)}
        >
          {props.actions.standupPending() || props.model.state.standupLoading
            ? t("common.loading")
            : props.actions.standup()
              ? t("logbook.standup.refresh")
              : t("logbook.standup.generate")}
        </ActionButton>
      </div>
      <Show
        when={props.actions.standup()}
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

function Ask(props: { model: LogbookModel; actions: LogbookActions }) {
  const [question, setQuestion] = createSignal("");
  return (
    <section class="card logbook-side__card">
      <div class="card-title">{t("logbook.ask.title")}</div>
      <form
        class="logbook-ask__form"
        onSubmit={(event) => {
          event.preventDefault();
          void props.actions.ask(question());
        }}
      >
        <input
          class="logbook-ask__input"
          type="text"
          value={question()}
          placeholder={t("logbook.ask.placeholder")}
          onInput={(event) => {
            setQuestion(event.currentTarget.value);
          }}
        />
        <ActionButton
          type="submit"
          disabled={props.actions.askPending() || props.model.state.askLoading}
        >
          {props.actions.askPending() || props.model.state.askLoading
            ? t("common.loading")
            : t("logbook.ask.submit")}
        </ActionButton>
      </form>
      <Show when={props.actions.answer()}>
        <p class="logbook-ask__answer">{props.actions.answer()}</p>
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
  // PluginPage's keyed host keeps this client fixed until the model is disposed.
  const initialClient = props.initialClient;
  const model = createLogbook(initialClient);
  const actions = createLogbookActions(model, () => props.getRetired());
  const state = () => model.state;
  const day = createMemo(() => state().day);
  const [completion, setCompletion] = createSignal<Promise<void>>();
  const timelineRead = createMemo(() => completion());
  const load = (options?: Parameters<LogbookModel["load"]>[0]) => {
    const admitted = model.load(options);
    void setCompletion(admitted);
    return admitted;
  };
  const readTimeline = () => {
    latest(timelineRead);
    return null;
  };
  // PluginPageOwner remounts this view when the connection changes.
  onSettled(() => void load());
  const isToday = () => state().day === (state().status?.today ?? localDayKey());
  return (
    <section class="logbook">
      <header class="logbook__header">
        <div class="logbook__daynav">
          <ActionButton
            onClick={() => void load({ day: shiftDay(state().day, -1) })}
            aria-label={t("logbook.nav.previousDay")}
          >
            ‹
          </ActionButton>
          <span class="logbook__day">{state().day}</span>
          <ActionButton
            onClick={() => void load({ day: shiftDay(state().day, 1) })}
            disabled={isToday()}
            aria-label={t("logbook.nav.nextDay")}
          >
            ›
          </ActionButton>
          <Show when={!isToday()}>
            <ActionButton onClick={() => void load({ today: true })}>
              {t("logbook.nav.today")}
            </ActionButton>
          </Show>
        </div>
        <Show when={actions.status()}>{(status) => <StatusChips status={status()} />}</Show>
        <div class="logbook__actions">
          <Show when={actions.status()}>
            {(status) => (
              <ActionButton
                disabled={
                  actions.actionPending() || state().actionPending || !status().captureEnabled
                }
                onClick={() => void actions.setCapturePaused(!actions.status()?.capturePaused)}
              >
                {t(status().capturePaused ? "logbook.actions.resume" : "logbook.actions.pause")}
              </ActionButton>
            )}
          </Show>
          <ActionButton
            onClick={() => void actions.analyze()}
            disabled={actions.actionPending() || state().actionPending}
          >
            {t("logbook.actions.analyzeNow")}
          </ActionButton>
          <ActionButton onClick={() => void load()} disabled={state().loading}>
            <Icon name="refresh" />
          </ActionButton>
        </div>
      </header>
      <Show when={state().error}>
        <div class="callout danger" role="alert">
          {state().error}
        </div>
      </Show>
      <div class="logbook__layout">
        <div class="logbook__timeline">
          <Errored
            fallback={(error, reset) => (
              <div class="callout danger" role="alert">
                {formatUiError(error())}
                <ActionButton
                  onClick={() => {
                    void load();
                    reset();
                  }}
                >
                  {t("common.retry")}
                </ActionButton>
              </div>
            )}
          >
            <Loading on={day()} fallback={<div class="card-sub">{t("common.loading")}</div>}>
              {readTimeline()}
              <Show when={isPending(timelineRead) && (state().timeline?.cards.length ?? 0) === 0}>
                <div class="card-sub">{t("common.loading")}</div>
              </Show>
              <Show
                when={
                  !isPending(timelineRead) &&
                  (state().timeline?.cards.length ?? 0) === 0 &&
                  !state().error
                }
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
                      model={model}
                      card={card()}
                      timeZone={state().status!.timeZone}
                      formatClock={formatClock}
                    />
                  )}
                </For>
              </Show>
            </Loading>
          </Errored>
        </div>
        <aside class="logbook__side">
          <Stats state={state} />
          <Standup model={model} actions={actions} />
          <Ask model={model} actions={actions} />
        </aside>
      </div>
    </section>
  );
}
