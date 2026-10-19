import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
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
import { createLogbook, localDayKey, shiftDay, type LogbookModel } from "./logbook-state.ts";
import type { LogbookCardPayload, LogbookStatusPayload, LogbookUiState } from "./logbook-types.ts";

export type LogbookProps = {
  initialClient: GatewayBrowserClient | null;
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

function Standup(props: { model: LogbookModel }) {
  return (
    <section class="card logbook-side__card">
      <div class="logbook-side__card-header">
        <div class="card-title">{t("logbook.standup.title")}</div>
        <ActionButton
          disabled={props.model.state.standupLoading}
          onClick={() => void props.model.standup(props.model.state.standup !== null)}
        >
          {props.model.state.standupLoading
            ? t("common.loading")
            : props.model.state.standup
              ? t("logbook.standup.refresh")
              : t("logbook.standup.generate")}
        </ActionButton>
      </div>
      <Show
        when={props.model.state.standup}
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

function Ask(props: { model: LogbookModel }) {
  const [question, setQuestion] = createSignal("");
  return (
    <section class="card logbook-side__card">
      <div class="card-title">{t("logbook.ask.title")}</div>
      <form
        class="logbook-ask__form"
        onSubmit={(event) => {
          event.preventDefault();
          void props.model.ask(question());
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
        <ActionButton type="submit" disabled={props.model.state.askLoading}>
          {props.model.state.askLoading ? t("common.loading") : t("logbook.ask.submit")}
        </ActionButton>
      </form>
      <Show when={props.model.state.askAnswer}>
        <p class="logbook-ask__answer">{props.model.state.askAnswer}</p>
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
  const state = () => model.state;
  // PluginPageOwner remounts this view when the connection changes.
  onSettled(() => void model.load());
  const isToday = () => state().day === (state().status?.today ?? localDayKey());
  return (
    <section class="logbook">
      <header class="logbook__header">
        <div class="logbook__daynav">
          <ActionButton
            onClick={() => void model.load({ day: shiftDay(state().day, -1) })}
            aria-label={t("logbook.nav.previousDay")}
          >
            ‹
          </ActionButton>
          <span class="logbook__day">{state().day}</span>
          <ActionButton
            onClick={() => void model.load({ day: shiftDay(state().day, 1) })}
            disabled={isToday()}
            aria-label={t("logbook.nav.nextDay")}
          >
            ›
          </ActionButton>
          <Show when={!isToday()}>
            <ActionButton onClick={() => void model.load({ today: true })}>
              {t("logbook.nav.today")}
            </ActionButton>
          </Show>
        </div>
        <Show when={state().status}>{(status) => <StatusChips status={status()} />}</Show>
        <div class="logbook__actions">
          <Show when={state().status}>
            {(status) => (
              <ActionButton
                disabled={state().actionPending || !status().captureEnabled}
                onClick={() => void model.setCapturePaused(!state().status?.capturePaused)}
              >
                {t(status().capturePaused ? "logbook.actions.resume" : "logbook.actions.pause")}
              </ActionButton>
            )}
          </Show>
          <ActionButton onClick={() => void model.analyze()} disabled={state().actionPending}>
            {t("logbook.actions.analyzeNow")}
          </ActionButton>
          <ActionButton onClick={() => void model.load()} disabled={state().loading}>
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
                  model={model}
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
          <Standup model={model} />
          <Ask model={model} />
        </aside>
      </div>
    </section>
  );
}
