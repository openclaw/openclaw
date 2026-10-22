import type { TranscriptSessionSummary } from "@openclaw/gateway-protocol";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show, createMemo, latest, onSettled } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerMeetingsEnglish } from "../../i18n/locales/en-meetings.ts";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { SETTINGS_SEARCH_TARGETS } from "../config/settings-targets.ts";
import { MeetingSummary } from "./meeting-summary.tsx";
import {
  transcriptRouteSearch,
  transcriptListParams,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_ADVANCED_FILTER_KEYS,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";
import type { TranscriptsViewProps } from "./view-types.ts";

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

function ReadError(props: {
  error: unknown;
  retry: () => void;
  onFocusTarget?: (element: HTMLElement) => (() => void) | undefined;
}) {
  let element!: HTMLDivElement;
  onSettled(() => props.onFocusTarget?.(element));
  const forbidden = () => isArchiveAccessDeniedError(props.error);
  return (
    <div ref={(node) => (element = node)} class="transcripts-notice" role="alert" tabindex="-1">
      <h2>{t(forbidden() ? "transcripts.forbidden" : "transcripts.loadError")}</h2>
      <p>{forbidden() ? t("transcripts.forbiddenHint") : formatUiError(props.error)}</p>
      <button class="btn" onClick={() => props.retry()}>
        {t("common.retry")}
      </button>
    </div>
  );
}

function LoadingIndicator(props: { label: string }) {
  return (
    <div class="meetings-loading" role="status" aria-live="polite">
      <span class="btn__spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

function ReadBoundary(props: {
  read: () => void;
  scope: string;
  loading?: JSX.Element;
  retry?: () => void;
  onFocusTarget?: (element: HTMLElement) => (() => void) | undefined;
  error?: JSX.Element;
  children?: JSX.Element;
}) {
  const ready = () => {
    latest(props.read);
    return null;
  };
  return (
    <Show when={props.scope} keyed>
      {/* A value-taking child lets keyed Show replace the error scope. */}
      {(_scope) => (
        <Errored
          fallback={(error, reset) =>
            props.retry ? (
              <ReadError
                error={error()}
                retry={() => {
                  props.retry?.();
                  reset();
                }}
                onFocusTarget={props.onFocusTarget}
              />
            ) : (
              (props.error ?? null)
            )
          }
        >
          <Loading fallback={props.loading ?? null}>
            {ready()}
            {props.children}
          </Loading>
        </Errored>
      )}
    </Show>
  );
}

function FilterField(props: TranscriptsViewProps & { name: string; label: string; type?: string }) {
  let input!: HTMLInputElement;
  onSettled(() => (props.name === "query" ? props.onFocusTarget?.("search", input) : undefined));
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? "search"}
        aria-label={props.label}
        maxlength={TRANSCRIPT_QUERY_LIMIT}
        ref={[liveValue(() => props.drafts[props.name] ?? ""), (element) => (input = element)]}
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
      ) : (
        <ReadBoundary
          read={props.listRead}
          scope={JSON.stringify(transcriptListParams(props.search))}
          loading={<LoadingIndicator label={t("meetings.loadingMeetings")} />}
          retry={props.onRefresh}
        >
          {!props.list ? (
            <LoadingIndicator label={t("meetings.loadingMeetings")} />
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
                      TRANSCRIPT_FILTER_KEYS.some((key) =>
                        new URLSearchParams(props.search).has(key),
                      )
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
        </ReadBoundary>
      )}
    </>
  );
}

function ReaderHeading(props: Pick<TranscriptsViewProps, "onFocusTarget"> & { title: string }) {
  let heading!: HTMLHeadingElement;
  onSettled(() => props.onFocusTarget?.("reader-title", heading));
  return (
    <h1 ref={(element) => (heading = element)} tabindex="-1">
      {props.title}
    </h1>
  );
}

function Reader(props: TranscriptsViewProps) {
  const params = () => new URLSearchParams(props.search);
  const readScope = () => JSON.stringify([props.search, props.readerTab]);
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
        <ReadError
          error={props.reader.error}
          retry={props.onReaderRetry}
          onFocusTarget={(element) => props.onFocusTarget?.("reader-error", element)}
        />
      ) : (
        <ReadBoundary
          read={props.reader.read}
          scope={readScope()}
          retry={props.onReaderRetry}
          onFocusTarget={(element) => props.onFocusTarget?.("reader-error", element)}
        />
      )}
      {props.reader.loading && !tabPage() ? (
        <LoadingIndicator
          label={t(
            props.readerTab === "summary"
              ? "meetings.loadingSummary"
              : "meetings.loadingTranscript",
          )}
        />
      ) : null}
      <Show when={page()}>
        {(currentPage) => (
          <>
            <header class="transcripts-reader__header">
              <ReaderHeading
                title={currentPage().session.title || currentPage().session.sessionId}
                onFocusTarget={props.onFocusTarget}
              />
              <p class="transcripts-caption">
                {currentPage().session.providerName || currentPage().session.providerId} ·{" "}
                <time datetime={currentPage().session.startedAt}>
                  {transcriptTime(currentPage().session.startedAt)}
                </time>
                {" · "}
                {t("transcripts.savedCount", {
                  count: String(currentPage().session.utteranceCount),
                })}
              </p>
              {currentPage().session.active ? (
                <div class="meetings-live-status" role="status">
                  <div class="meetings-live-status__heading">
                    <span class="meetings-live">{t("meetings.liveCapture")}</span>
                    <span class="meetings-live-status__elapsed" role="timer" aria-live="off">
                      {formatDurationCompact(
                        Math.max(0, props.now - Date.parse(currentPage().session.startedAt)),
                      )}
                    </span>
                  </div>
                  <ReadBoundary
                    read={props.reader.read}
                    scope={readScope()}
                    error={<p>{t("meetings.liveRetrying")}</p>}
                  >
                    <p>{t(props.reader.error ? "meetings.liveRetrying" : "meetings.liveHint")}</p>
                  </ReadBoundary>
                </div>
              ) : null}
              <details class="transcripts-source-details">
                <summary>{t("transcripts.sourceDetails")}</summary>
                <p class="transcripts-caption">
                  {transcriptSourceLabel(currentPage().session.source)}
                </p>
                <p class="transcripts-caption">
                  {currentPage().session.agentId ?? t("transcripts.unattributed")}
                </p>
                <p class="transcripts-caption">
                  {t("transcripts.lastUtterance", {
                    time: transcriptTime(currentPage().session.lastUtteranceAt),
                  })}
                </p>
                <p class="transcripts-caption">
                  {t(
                    currentPage().session.activeSubscription
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
            <HubTabs<TranscriptsViewProps["readerTab"]>
              id="transcript-reader"
              active={props.readerTab}
              tabs={[
                { value: "summary", label: t("transcripts.summary") },
                { value: "text", label: t("transcripts.text") },
              ]}
              ariaLabel={t("transcripts.reader")}
              panelId="transcript-reader-panel"
              variant="sub"
              onSelect={(tab) => props.onReaderTab(tab)}
            />
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
                        find: normalizeNullableString(
                          new FormData(event.currentTarget).get("find"),
                        ),
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
                    <ReadBoundary read={props.reader.read} scope={readScope()}>
                      <p role="status">
                        {t(
                          params().get("find")
                            ? "transcripts.noMatches"
                            : currentPage().session.active
                              ? "meetings.waitingForSpeech"
                              : "transcripts.noUtterances",
                        )}
                      </p>
                    </ReadBoundary>
                  ) : null}
                  {props.reader.loading && transcriptPage()?.nextCursor ? (
                    <LoadingIndicator label={t("meetings.loadingTranscript")} />
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </Show>
    </article>
  );
}

export function TranscriptsView(props: TranscriptsViewProps) {
  const captureTarget = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return (
    <section class="transcripts-workspace">
      <HubPageHeader
        active="meetings"
        docsUrl="https://docs.openclaw.ai/cli/transcripts"
        actions={
          <div class="transcripts-actions">
            <a
              class="btn"
              href={
                pathForRoute(captureTarget.routeId, props.basePath) +
                captureTarget.search +
                captureTarget.hash
              }
              onClick={(event) => {
                if (!shouldHandleNavigationClick(event)) {
                  return;
                }
                event.preventDefault();
                props.onOpenCaptureSettings();
              }}
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
        }
      />
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
