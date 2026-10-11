import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import type { TranscriptSessionSummary } from "@openclaw/gateway-protocol";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, createEffect } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { syncTabGroupLabel } from "../../components/web-awesome-tabs.ts";
import "../../styles/hub-tabs.css";
import { registerMeetingsEnglish } from "../../i18n/locales/en-meetings.ts";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/solid-dom.ts";
import { SETTINGS_SEARCH_TARGETS } from "../config/settings-targets.ts";
import { MeetingSummary } from "./meeting-summary.tsx";
import {
  transcriptRouteSearch,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_ADVANCED_FILTER_KEYS,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";
import type { TranscriptsViewProps } from "./view-types.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab": HTMLAttributes<WaTab> & {
        panel: string;
        active: boolean;
        "prop:tabIndex": WaTab["tabIndex"];
      };
      "wa-tab-group": HTMLAttributes<WaTabGroup> & {
        activation: "manual";
        "prop:active": WaTabGroup["active"];
        "without-scroll-controls": boolean;
      };
    }
  }
}

registerEnglishCatalog(registerTranscriptsEnglish);
registerEnglishCatalog(registerMeetingsEnglish);

function transcriptTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : t("transcripts.unknown");
}

function SourceTime(props: { value: string | undefined }) {
  const label = () => t("transcripts.sourceTime", { time: transcriptTime(props.value) });
  return (
    <time datetime={props.value} title={label()} aria-label={label()}>
      {props.value ? new Date(props.value).toLocaleTimeString() : t("transcripts.unknown")}
    </time>
  );
}

function transcriptSourceLabel(source: TranscriptSessionSummary["source"]) {
  return [
    source.providerId,
    source.accountId,
    source.guildId,
    source.channelId,
    source.meetingUrl,
    source.threadTs,
    source.fileId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ReadError(props: { error: unknown; retry: () => void }) {
  const forbidden = () => isArchiveAccessDeniedError(props.error);
  return (
    <div class="transcripts-notice" role="alert" tabindex="-1">
      <h2>{t(forbidden() ? "transcripts.forbidden" : "transcripts.loadError")}</h2>
      <p>{forbidden() ? t("transcripts.forbiddenHint") : formatUiError(props.error)}</p>
      <button class="btn" onClick={() => props.retry()}>
        {t("common.retry")}
      </button>
    </div>
  );
}

function Loading(props: { label: string }) {
  return (
    <div class="meetings-loading" role="status" aria-live="polite">
      <span class="btn__spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

function FilterField(props: TranscriptsViewProps & { name: string; label: string; type?: string }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? "search"}
        aria-label={props.label}
        maxlength={TRANSCRIPT_QUERY_LIMIT}
        ref={liveValue(() => props.drafts[props.name] ?? "")}
        onInput={(event) => props.onDraft(props.name, event.currentTarget.value)}
      />
    </label>
  );
}

function Filters(props: TranscriptsViewProps) {
  return (
    <form
      class="transcripts-filters"
      aria-label={t("transcripts.filters")}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const patch: Record<string, string | null> = { cursor: null };
        for (const key of TRANSCRIPT_FILTER_KEYS) {
          patch[key] = normalizeNullableString(data.get(key));
        }
        props.onNavigate(patch);
      }}
    >
      <FilterField {...props} name="query" label={t("transcripts.titleFilter")} />
      <details
        open={TRANSCRIPT_ADVANCED_FILTER_KEYS.some((key) =>
          new URLSearchParams(props.search).get(key),
        )}
      >
        <summary>{t("transcripts.advancedFilters")}</summary>
        <div class="transcripts-filters__advanced">
          <FilterField {...props} name="providerId" label={t("transcripts.sourceFilter")} />
          <FilterField {...props} name="accountId" label={t("transcripts.accountFilter")} />
          <FilterField {...props} name="agentId" label={t("transcripts.agentFilter")} />
          <FilterField
            {...props}
            name="startedAfter"
            label={t("transcripts.afterFilter")}
            type="date"
          />
          <FilterField
            {...props}
            name="startedBefore"
            label={t("transcripts.beforeFilter")}
            type="date"
          />
        </div>
        <p class="transcripts-caption">{t("transcripts.filterHint")}</p>
      </details>
      <div class="transcripts-actions">
        <button type="submit" class="btn">
          <Icon name="search" />
          {t("transcripts.filter")}
        </button>
        <button
          type="button"
          class="btn"
          onClick={() =>
            props.onNavigate(
              Object.fromEntries([...TRANSCRIPT_FILTER_KEYS, "cursor"].map((key) => [key, null])),
            )
          }
        >
          {t("transcripts.clearFilters")}
        </button>
      </div>
    </form>
  );
}

function MeetingRow(props: TranscriptsViewProps & { entry: TranscriptSessionSummary }) {
  const selection = () => ({ selector: props.entry.selector, find: null, tab: null });
  const participants = () => props.entry.participants.slice(0, 3).join(", ");
  const duration = () =>
    props.entry.stoppedAt
      ? formatDurationCompact(
          Math.max(0, Date.parse(props.entry.stoppedAt) - Date.parse(props.entry.startedAt)),
        )
      : null;
  return (
    <li>
      <a
        class={[
          "transcripts-list__entry",
          "meetings-row",
          { "meetings-row--silent": !props.entry.active && props.entry.utteranceCount === 0 },
        ]}
        aria-current={
          props.entry.selector === new URLSearchParams(props.search).get("selector")
            ? "page"
            : undefined
        }
        href={
          pathForRoute("meetings", props.basePath) +
          transcriptRouteSearch(props.search, selection())
        }
        onClick={(event) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          props.onNavigate(selection());
        }}
      >
        <span class="meetings-row__title">
          {props.entry.title || props.entry.providerName || props.entry.providerId}
        </span>
        <span class="meetings-row__meta">
          {props.entry.providerName || props.entry.providerId} ·{" "}
          <time datetime={props.entry.startedAt}>
            {new Date(props.entry.startedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>{" "}
          {props.entry.active ? (
            <span class="meetings-live">{t("meetings.inProgress")}</span>
          ) : duration() ? (
            ` · ${duration()}`
          ) : null}
        </span>
        {participants() ? (
          <span class="meetings-row__meta meetings-row__participants">
            {participants()}
            {props.entry.participants.length > 3 ? ` +${props.entry.participants.length - 3}` : ""}
          </span>
        ) : null}
        <span class="meetings-row__meta">
          {t("transcripts.savedCount", { count: String(props.entry.utteranceCount) })}
        </span>
        <span class="meetings-row__overview">
          {props.entry.utteranceCount === 0
            ? t(props.entry.active ? "meetings.waitingForSpeech" : "meetings.noSpeech")
            : props.entry.overview ||
              t(props.entry.active ? "meetings.summaryPending" : "meetings.summaryUnavailable")}
        </span>
      </a>
    </li>
  );
}

function Library(props: TranscriptsViewProps) {
  const days = createMemo(() => {
    const result = new Map<string, TranscriptSessionSummary[]>();
    for (const entry of props.list?.sessions ?? []) {
      const day = new Date(entry.startedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const entries = result.get(day) ?? [];
      entries.push(entry);
      result.set(day, entries);
    }
    return [...result].map(([day, entries]) => ({ day, entries }));
  });
  return (
    <>
      {props.listError ? (
        <ReadError error={props.listError} retry={props.onRefresh} />
      ) : !props.list ? (
        <Loading label={t("meetings.loadingMeetings")} />
      ) : (
        <>
          {days().length ? (
            <section class="meetings-timeline" aria-label={t("meetings.listLabel")}>
              <p class="transcripts-caption">{t("meetings.newestFirst")}</p>
              <For each={days()} keyed={(day) => day.day}>
                {(day) => (
                  <section class="meetings-day">
                    <h2>{day().day}</h2>
                    <ol class="transcripts-list">
                      <For each={day().entries} keyed={(entry) => entry.selector}>
                        {(entry) => <MeetingRow {...props} entry={entry()} />}
                      </For>
                    </ol>
                  </section>
                )}
              </For>
            </section>
          ) : (
            <div class="transcripts-notice" role="status">
              <h2>
                {t(
                  TRANSCRIPT_FILTER_KEYS.some((key) => new URLSearchParams(props.search).has(key))
                    ? "meetings.noResults"
                    : "meetings.emptyTitle",
                )}
              </h2>
              <p>{t("transcripts.emptyHint")}</p>
              <a
                href="https://docs.openclaw.ai/cli/transcripts"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("meetings.docs")}
              </a>
            </div>
          )}
          <nav class="transcripts-actions" aria-label={t("transcripts.pagination")}>
            {new URLSearchParams(props.search).has("cursor") ? (
              <button class="btn" onClick={() => props.onNavigate({ cursor: null })}>
                {t("transcripts.firstPage")}
              </button>
            ) : null}
            {props.list?.nextCursor ? (
              <button
                class="btn"
                onClick={() => props.onNavigate({ cursor: props.list?.nextCursor ?? null })}
              >
                {t("transcripts.nextPage")}
                <Icon name="chevronRight" />
              </button>
            ) : null}
          </nav>
        </>
      )}
    </>
  );
}

function Reader(props: TranscriptsViewProps) {
  let tabGroup: WaTabGroup | undefined;
  createEffect(
    () => t("transcripts.reader"),
    (label) => syncTabGroupLabel(tabGroup, label),
  );
  const params = () => new URLSearchParams(props.search);
  const transcriptPage = () => props.reader.pages.at(-1);
  const page = () => props.reader.summary ?? transcriptPage();
  const tabPage = () => (props.readerTab === "summary" ? props.reader.summary : transcriptPage());
  return (
    <article
      class="transcripts-reader"
      aria-label={t("transcripts.reader")}
      aria-busy={props.reader.loading ? "true" : "false"}
    >
      <a
        class="transcripts-back"
        href={
          pathForRoute("meetings", props.basePath) +
          transcriptRouteSearch(props.search, { selector: null, find: null, tab: null })
        }
        onClick={(event) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          props.onNavigate({ selector: null, find: null, tab: null });
        }}
      >
        <Icon name="arrowLeft" />
        {t("transcripts.back")}
      </a>
      {props.reader.error ? (
        <ReadError error={props.reader.error} retry={props.onReaderRetry} />
      ) : null}
      {props.reader.loading && !tabPage() ? (
        <Loading
          label={t(
            props.readerTab === "summary"
              ? "meetings.loadingSummary"
              : "meetings.loadingTranscript",
          )}
        />
      ) : null}
      {page() ? (
        <>
          <header class="transcripts-reader__header">
            <h1 tabindex="-1">{page()!.session.title || page()!.session.sessionId}</h1>
            <p class="transcripts-caption">
              {page()!.session.providerName || page()!.session.providerId} ·{" "}
              <time datetime={page()!.session.startedAt}>
                {transcriptTime(page()!.session.startedAt)}
              </time>
              {" · "}
              {t("transcripts.savedCount", { count: String(page()!.session.utteranceCount) })}
            </p>
            {page()!.session.active ? (
              <div class="meetings-live-status" role="status">
                <div class="meetings-live-status__heading">
                  <span class="meetings-live">{t("meetings.liveCapture")}</span>
                  <span class="meetings-live-status__elapsed" role="timer" aria-live="off">
                    {formatDurationCompact(
                      Math.max(0, props.now - Date.parse(page()!.session.startedAt)),
                    )}
                  </span>
                </div>
                <p>{t(props.reader.error ? "meetings.liveRetrying" : "meetings.liveHint")}</p>
              </div>
            ) : null}
            <details class="transcripts-source-details">
              <summary>{t("transcripts.sourceDetails")}</summary>
              <p class="transcripts-caption">{transcriptSourceLabel(page()!.session.source)}</p>
              <p class="transcripts-caption">
                {page()!.session.agentId ?? t("transcripts.unattributed")}
              </p>
              <p class="transcripts-caption">
                {t("transcripts.lastUtterance", {
                  time: transcriptTime(page()!.session.lastUtteranceAt),
                })}
              </p>
              <p class="transcripts-caption">
                {t(
                  page()!.session.activeSubscription
                    ? "transcripts.armedHint"
                    : "transcripts.inactiveHint",
                )}
              </p>
            </details>
            <div class="transcripts-actions">
              <For each={["markdown", "jsonl"] as const} keyed={(format) => format}>
                {(format) => (
                  <button
                    class="btn"
                    disabled={props.exportState.kind === "loading"}
                    onClick={() => props.onDownload(format())}
                  >
                    <Icon name="download" />
                    {t(`transcripts.download.${format()}`)}
                  </button>
                )}
              </For>
            </div>
            {props.exportState.kind === "error" ? (
              <p role="alert">
                {t("transcripts.exportError")} {props.exportState.message}
              </p>
            ) : null}
            {props.exportState.kind === "loading" || props.exportState.kind === "done" ? (
              <p role="status">
                {t(
                  props.exportState.kind === "loading"
                    ? "transcripts.exporting"
                    : "transcripts.downloadStarted",
                )}
              </p>
            ) : null}
          </header>
          <wa-tab-group
            ref={(element) => {
              tabGroup = element;
              syncTabGroupLabel(element, t("transcripts.reader"));
            }}
            class="hub-tabs hub-tabs--sub transcript-reader-hub-tabs"
            aria-label={t("transcripts.reader")}
            prop:active={props.readerTab}
            activation="manual"
            without-scroll-controls
          >
            <For each={["summary", "text"] as const} keyed={(tab) => tab}>
              {(tab) => (
                <wa-tab
                  id={`transcript-reader-tab-${tab()}`}
                  panel={tab()}
                  aria-controls="transcript-reader-panel"
                  class="hub-tab"
                  active={props.readerTab === tab()}
                  prop:tabIndex={props.readerTab === tab() ? 0 : -1}
                  aria-selected={props.readerTab === tab() ? "true" : "false"}
                  onClick={(event) => {
                    if (event.detail > 0 || event.isTrusted) {
                      props.onReaderTab(tab());
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      props.onReaderTab(tab());
                    }
                  }}
                >
                  {t(tab() === "summary" ? "transcripts.summary" : "transcripts.text")}
                </wa-tab>
              )}
            </For>
          </wa-tab-group>
          <div
            id="transcript-reader-panel"
            role="tabpanel"
            aria-labelledby={`transcript-reader-tab-${props.readerTab}`}
          >
            {props.readerTab === "summary" ? (
              <Show when={props.reader.summary}>
                {(summaryPage) => (
                  <MeetingSummary
                    page={summaryPage()}
                    generation={props.summaryGeneration}
                    onRetry={props.onSummaryRetry}
                  />
                )}
              </Show>
            ) : (
              <>
                <form
                  class="transcripts-search"
                  role="search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    props.onNavigate({
                      find: normalizeNullableString(new FormData(event.currentTarget).get("find")),
                      tab: "transcript",
                    });
                  }}
                >
                  <label class="field">
                    <input
                      type="search"
                      name="find"
                      aria-label={t("transcripts.searchWithin")}
                      placeholder={t("transcripts.searchWithin")}
                      maxlength={TRANSCRIPT_QUERY_LIMIT}
                      ref={liveValue(() => props.drafts.find ?? "")}
                      onInput={(event) => props.onDraft("find", event.currentTarget.value)}
                    />
                  </label>
                  <button class="btn" type="submit">
                    <Icon name="search" />
                    {t("transcripts.search")}
                  </button>
                  {params().get("find") ? (
                    <button
                      class="btn"
                      type="button"
                      onClick={() => props.onNavigate({ find: null })}
                    >
                      {t("transcripts.clearSearch")}
                    </button>
                  ) : null}
                </form>
                {params().get("find") ? (
                  <p class="transcripts-caption" role="status">
                    {t("transcripts.searchResults", { query: params().get("find") ?? "" })}
                  </p>
                ) : null}
                <ol class="transcripts-utterances">
                  <For
                    each={props.reader.pages.flatMap((result) => result.utterances ?? [])}
                    keyed={(utterance) => utterance.sequence}
                  >
                    {(utterance) => (
                      <li>
                        <div class="transcripts-utterance__byline">
                          <strong>
                            {utterance().speakerLabel ??
                              utterance().speakerId ??
                              t("transcripts.unknownSpeaker")}
                          </strong>
                          <SourceTime value={utterance().startedAt ?? utterance().endedAt} />
                        </div>
                        <p>{utterance().text}</p>
                      </li>
                    )}
                  </For>
                </ol>
                {transcriptPage() &&
                !props.reader.error &&
                !props.reader.pages.some((result) => result.utterances?.length) ? (
                  <p role="status">
                    {t(
                      params().get("find")
                        ? "transcripts.noMatches"
                        : page()!.session.active
                          ? "meetings.waitingForSpeech"
                          : "transcripts.noUtterances",
                    )}
                  </p>
                ) : null}
                {props.reader.loading && transcriptPage()?.nextCursor ? (
                  <Loading label={t("meetings.loadingTranscript")} />
                ) : null}
              </>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

export function TranscriptsView(props: TranscriptsViewProps) {
  const captureTarget = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return (
    <section class="transcripts-workspace">
      <header class="content-header content-header--page">
        <div>
          <h1 class="page-title">{t("tabs.meetings")}</h1>
          <p class="page-sub">{t("subtitles.meetings")}</p>
        </div>
        <div class="transcripts-actions">
          <a
            class="btn"
            href={
              pathForRoute(captureTarget.routeId, props.basePath) +
              captureTarget.search +
              captureTarget.hash
            }
          >
            <Icon name="settings" />
            {t("meetingCapture.title")}
          </a>
          <button
            class="btn"
            disabled={!props.connected || !props.allowed || props.listLoading}
            onClick={() => props.onRefresh()}
          >
            <Icon name="refresh" />
            {t("common.refresh")}
          </button>
        </div>
      </header>
      {!props.connected ? (
        <div class="transcripts-notice" role="status">
          {t("transcripts.disconnected")}
        </div>
      ) : !props.allowed ? (
        <div class="transcripts-notice" role="alert">
          <h2>{t("transcripts.forbidden")}</h2>
          <p>{t("transcripts.forbiddenHint")}</p>
        </div>
      ) : (
        <div
          class={[
            "transcripts-layout",
            {
              "transcripts-layout--selected": Boolean(
                new URLSearchParams(props.search).get("selector"),
              ),
            },
          ]}
        >
          <section
            class="transcripts-library"
            aria-label={t("transcripts.library")}
            aria-busy={props.listLoading ? "true" : "false"}
          >
            <Filters {...props} />
            <Library {...props} />
          </section>
          {new URLSearchParams(props.search).get("selector") ? <Reader {...props} /> : null}
        </div>
      )}
    </section>
  );
}
