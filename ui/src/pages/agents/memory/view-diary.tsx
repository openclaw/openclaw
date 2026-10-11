import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { createMemo, For, Show, untrack } from "solid-js";
import { renderHubTabs } from "../../../components/hub-tabs.ts";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-bridge.ts";
import { DiaryEmpty, DreamingAction } from "./view-shared.tsx";
import type { DreamingProps } from "./view-types.ts";
import {
  ImportedInsightsContent,
  renderWikiPreviewOverlay,
  WikiOverviewContent,
} from "./view-wiki.tsx";

type DiaryEntry = {
  date: string;
  body: string;
};

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;

const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

function parseDiaryEntries(raw: string): DiaryEntry[] {
  let content = raw;
  const startMatch = DIARY_START_RE.exec(raw);
  const endMatch = DIARY_END_RE.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  const entries: DiaryEntry[] = [];
  for (const block of content.split(/\n---\n/)) {
    const lines = block.trim().split("\n");
    let date = "";
    const bodyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Date lines are wrapped in *asterisks* like: *April 5, 2026, 3:00 AM*
      if (!date && trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      if (trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
        continue;
      }
      if (trimmed.length > 0) {
        bodyLines.push(trimmed);
      }
    }

    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join("\n") });
    }
  }

  return entries;
}

function formatDiaryChipLabel(date: string): string {
  const parsed = parseDateStringTimestampMs(date);
  if (parsed === undefined) {
    return date;
  }
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

// Strip source citations like [memory/2026-04-09.md:9] and section headings,
// flatten structured diary entries into plain paragraphs.
function flattenDiaryBody(body: string): string[] {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      // Remove section headings that leak implementation.
      .filter(
        (line) =>
          line.length > 0 &&
          line !== "What Happened" &&
          line !== "Reflections" &&
          line !== "Candidates" &&
          line !== "Possible Lasting Updates",
      )
      .map((line) =>
        line
          .replace(/\s*\[memory\/[^\]]+\]/g, "")
          .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, "")
          .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, "")
          .trim(),
      )
      .filter((line) => line.length > 0)
  );
}

function DiaryNavigation(props: {
  labels: string[];
  selectedPage: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div class="dreams-diary__daychips">
      <For each={props.labels} keyed={false}>
        {(label, index) => (
          <button
            class={[
              "dreams-diary__day-chip",
              { "dreams-diary__day-chip--active": index === props.selectedPage },
            ]}
            onClick={() => props.onSelect(index)}
          >
            {label()}
          </button>
        )}
      </For>
    </div>
  );
}

function DreamDiaryContent(props: {
  entries: DiaryEntry[];
  selectedPage: number;
  missing: boolean;
}) {
  const selected = createMemo(() => props.entries[props.selectedPage]);
  return (
    <Show
      when={selected()}
      fallback={
        <DiaryEmpty
          message={t(props.missing ? "dreaming.diary.noDreamsYet" : "dreaming.diary.waitingTitle")}
          hint={t(props.missing ? "dreaming.diary.noDreamsHint" : "dreaming.diary.waitingHint")}
        >
          <Show when={props.missing}>
            <div class="dreams-diary__empty-moon">
              <svg viewBox="0 0 32 32" fill="none" width="32" height="32">
                <circle
                  cx="16"
                  cy="16"
                  r="14"
                  stroke="currentColor"
                  stroke-width="0.5"
                  opacity="0.2"
                />
                <path
                  d="M20 8a10 10 0 0 1 0 16 10 10 0 1 0 0-16z"
                  fill="currentColor"
                  opacity="0.08"
                />
              </svg>
            </div>
          </Show>
        </DiaryEmpty>
      }
    >
      {(entry) => (
        <article class="dreams-diary__entry">
          <div class="dreams-diary__accent" />
          <Show when={entry().date}>
            {(date) => <time class="dreams-diary__date">{date()}</time>}
          </Show>
          <div class="dreams-diary__prose">
            <For each={flattenDiaryBody(entry().body)} keyed={false}>
              {(para, index) => (
                <MarkdownHtml
                  as="p"
                  class="dreams-diary__para"
                  style={{ "animation-delay": `${0.3 + index * 0.15}s` }}
                  markdown={para()}
                />
              )}
            </For>
          </div>
        </article>
      )}
    </Show>
  );
}

export function renderDiarySection(props: DreamingProps) {
  const state = untrack(() => props.viewState);
  const activeDiarySubTab = createMemo(() => state.activeDiarySubTab);
  const content = createMemo(() => props.dreamDiaryContent);
  const entries = createMemo(() => {
    const current = content();
    return typeof current === "string" ? parseDiaryEntries(current).toReversed() : [];
  });
  const imports = createMemo(() => props.wikiImportInsights);
  const overview = createMemo(() => props.wikiOverview);
  const labels = createMemo(() =>
    activeDiarySubTab() === "dreams"
      ? entries().map((entry) => formatDiaryChipLabel(entry.date))
      : activeDiarySubTab() === "insights"
        ? (imports()?.clusters.map((cluster) => cluster.label) ?? [])
        : (overview()?.clusters.map((cluster) => cluster.label) ?? []),
  );
  const selectedPage = createMemo(() =>
    Math.max(0, Math.min(state.diaryPage, labels().length - 1)),
  );
  const diary = createMemo(
    () =>
      ({
        dreams: {
          error: props.dreamDiaryError,
          loading: props.dreamDiaryLoading,
          refresh: props.onRefreshDiary,
          explainer: "dreaming.wiki.dreamsExplainer",
        },
        insights: {
          error: props.wikiImportInsightsError,
          loading: props.wikiImportInsightsLoading,
          refresh: props.onRefreshImports,
          explainer: "dreaming.wiki.insightsExplainer",
        },
        wiki: {
          error: props.wikiOverviewError,
          loading: props.wikiOverviewLoading,
          refresh: props.onRefreshWikiOverview,
          explainer: "dreaming.wiki.wikiExplainer",
        },
      })[activeDiarySubTab()],
  );
  const memoryWikiUnavailable = createMemo(
    () => activeDiarySubTab() !== "dreams" && !props.memoryWikiEnabled,
  );
  return (
    <section class="dreams-diary">
      <Show
        when={!(diary().error && !memoryWikiUnavailable())}
        fallback={<div class="dreams-diary__error">{diary().error}</div>}
      >
        <div class="dreams-diary__chrome">
          <div class="dreams-diary__header">
            <span class="dreams-diary__title">{t("dreaming.diary.title")}</span>
            <LitContent
              render={() =>
                renderHubTabs({
                  id: "dream-diary",
                  active: activeDiarySubTab(),
                  tabs: [
                    { value: "dreams", label: t("dreaming.wiki.dreamsTab") },
                    { value: "insights", label: t("dreaming.wiki.insightsTab") },
                    { value: "wiki", label: t("dreaming.wiki.wikiTab") },
                  ],
                  ariaLabel: t("dreaming.diary.title"),
                  panelId: "dream-diary-panel",
                  variant: "sub",
                  onSelect: (tab) => {
                    state.wikiPreview = null;
                    state.activeDiarySubTab = tab;
                    state.diaryPage = 0;
                    props.onViewStateChange();
                  },
                })
              }
            />
            <DreamingAction
              label={
                memoryWikiUnavailable()
                  ? t("dreaming.wiki.howToEnable")
                  : activeDiarySubTab() === "dreams"
                    ? t(diary().loading ? "dreaming.diary.reloading" : "dreaming.diary.reload")
                    : diary().loading
                      ? "Reloading…"
                      : "Reload"
              }
              disabled={
                memoryWikiUnavailable()
                  ? !props.access.canOpenConfig
                  : props.modeSaving || diary().loading
              }
              onClick={() => {
                state.diaryPage = 0;
                if (memoryWikiUnavailable()) {
                  props.onOpenConfig();
                } else {
                  diary().refresh();
                }
              }}
            />
          </div>
          <p class="dreams-diary__explainer">{t(diary().explainer)}</p>
          <Show when={!memoryWikiUnavailable() && labels().length > 0}>
            <DiaryNavigation
              labels={labels()}
              selectedPage={selectedPage()}
              onSelect={(index) => {
                state.diaryPage = index;
                props.onViewStateChange();
              }}
            />
          </Show>
        </div>
        <div
          id="dream-diary-panel"
          role="tabpanel"
          aria-labelledby={`dream-diary-tab-${activeDiarySubTab()}`}
        >
          <Show
            when={!memoryWikiUnavailable()}
            fallback={
              <div class="dreams-diary__empty">
                <div class="dreams-diary__empty-text">{t("dreaming.wiki.unavailable")}</div>
                <div class="dreams-diary__empty-hint">
                  {t("dreaming.wiki.unavailablePluginPrefix")} <code>memory-wiki</code>{" "}
                  {t("dreaming.wiki.unavailablePluginSuffix")}
                </div>
                <div class="dreams-diary__empty-hint">
                  {t("dreaming.wiki.enablePrefix")}{" "}
                  <code>plugins.entries.memory-wiki.enabled = true</code>
                  {t("dreaming.wiki.enableSuffix")}
                </div>
                <div class="dreams-diary__empty-actions">
                  <DreamingAction
                    label={t("dreaming.wiki.openConfig")}
                    disabled={!props.access.canOpenConfig}
                    onClick={() => props.onOpenConfig()}
                  />
                </div>
              </div>
            }
          >
            {activeDiarySubTab() === "dreams" ? (
              <DreamDiaryContent
                entries={entries()}
                selectedPage={selectedPage()}
                missing={content() === null}
              />
            ) : activeDiarySubTab() === "insights" ? (
              <ImportedInsightsContent
                owner={props}
                data={imports()}
                selectedPage={selectedPage()}
                loading={props.wikiImportInsightsLoading}
              />
            ) : (
              <WikiOverviewContent
                owner={props}
                data={overview()}
                selectedPage={selectedPage()}
                loading={props.wikiOverviewLoading}
              />
            )}
          </Show>
        </div>
        {renderWikiPreviewOverlay(props)}
      </Show>
    </section>
  );
}
