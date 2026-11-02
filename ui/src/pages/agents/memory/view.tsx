import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { HubTabs } from "../../../components/solid/hub-tabs.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/dreams.css";
import type { DreamingEntry, DreamingViewState } from "./dreaming.ts";
import { DreamingScene } from "./view-scene.tsx";
import { DiaryEmpty, DreamingAction, DreamingRead, formatCompactDateTime } from "./view-shared.tsx";
import type { DreamingProps } from "./view-types.ts";
import { ImportedInsightsContent, WikiPreviewOverlay, WikiOverviewContent } from "./view-wiki.tsx";

const DREAM_ACTIONS = [
  ["dedupeDiary", "onDedupeDreamDiary", "canDedupeDreamDiary"],
  ["repairCache", "onRepairDreamingArtifacts", "canRepairDreamingArtifacts"],
  ["backfill", "onBackfillDiary", "canBackfillDiary"],
  ["reset", "onResetDiary", "canResetDiary"],
  ["clearGrounded", "onResetGroundedShortTerm", "canResetGroundedShortTerm"],
] as const;

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function compareWaitingEntryByRecency(a: DreamingEntry, b: DreamingEntry): number {
  const aMs = parseDateStringTimestampMs(a.lastRecalledAt) ?? Number.NEGATIVE_INFINITY;
  const bMs = parseDateStringTimestampMs(b.lastRecalledAt) ?? Number.NEGATIVE_INFINITY;
  if (bMs !== aMs) {
    return bMs - aMs;
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareWaitingEntryBySignals(a: DreamingEntry, b: DreamingEntry): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareWaitingEntryByRecency(a, b);
}

function describeWaitingEntryOrigin(entry: DreamingEntry): string {
  return t(
    entry.groundedCount > 0
      ? entry.recallCount > 0 || entry.dailyCount > 0
        ? "dreaming.advanced.originMixed"
        : "dreaming.advanced.originDailyLog"
      : "dreaming.advanced.originLive",
  );
}

function AdvancedEntryList(params: {
  titleKey: string;
  descriptionKey: string;
  emptyKey: string;
  entries: DreamingEntry[];
  meta: (entry: DreamingEntry) => string[];
  badge?: (entry: DreamingEntry) => string | null;
  controls?: JSX.Element;
}) {
  return (
    <section class="dreams-advanced__section">
      <div class="dreams-advanced__section-header">
        <div class="dreams-advanced__section-copy">
          <span class="dreams-advanced__section-title">{t(params.titleKey)}</span>
          <p class="dreams-advanced__section-description">{t(params.descriptionKey)}</p>
        </div>
        <div class="dreams-advanced__section-toolbar">
          {params.controls ?? undefined}
          <span class="dreams-advanced__section-count">{params.entries.length}</span>
        </div>
      </div>

      {params.entries.length === 0 ? (
        <div class="dreams-advanced__empty">{t(params.emptyKey)}</div>
      ) : (
        <div class="dreams-advanced__list">
          <For each={params.entries} keyed={(entry) => entry.key}>
            {(entry) => {
              const badge = () => params.badge?.(entry());
              return (
                <article class="dreams-advanced__item" data-entry-key={entry().key}>
                  {badge() ? <span class="dreams-advanced__badge">{badge()}</span> : undefined}
                  <div class="dreams-advanced__snippet">{entry().snippet}</div>
                  <div class="dreams-advanced__source">
                    {formatRange(entry().path, entry().startLine, entry().endLine)}
                  </div>
                  <div class="dreams-advanced__meta">
                    {params
                      .meta(entry())
                      .filter((part) => part.length > 0)
                      .join(" · ")}
                  </div>
                </article>
              );
            }}
          </For>
        </div>
      )}
    </section>
  );
}

function DreamingAdvancedSection(props: DreamingProps) {
  const state = () => props.viewState;
  const data = () => props.readStatusData();
  const groundedEntries = createMemo(() =>
    data().shortTermEntries.filter((entry) => entry.groundedCount > 0),
  );
  const waitingEntries = createMemo(() =>
    data().shortTermEntries.toSorted(
      state().advancedWaitingSort === "signals"
        ? compareWaitingEntryBySignals
        : compareWaitingEntryByRecency,
    ),
  );
  const description = () => t("dreaming.advanced.description");
  const summary = () =>
    [
      `${groundedEntries().length} ${t("dreaming.advanced.summaryFromDailyLog")}`,
      `${data().shortTermCount} ${t("dreaming.advanced.summaryWaiting")}`,
      `${data().promotedCount} ${t("dreaming.advanced.summaryPromotedToday")}`,
    ].join(" · ");

  return (
    <section class="dreams-advanced">
      <div class="dreams-advanced__header">
        <div class="dreams-advanced__intro">
          <span class="dreams-advanced__eyebrow">{t("dreaming.advanced.eyebrow")}</span>
          <h2 class="dreams-advanced__title">{t("dreaming.advanced.title")}</h2>
          {description() ? <p class="dreams-advanced__description">{description()}</p> : undefined}
          <DreamingRead on={props.selectedAgentId}>
            <div class="dreams-advanced__summary">{summary()}</div>
          </DreamingRead>
        </div>
        <div class="dreams-advanced__actions">
          <For each={DREAM_ACTIONS}>
            {([label, onClick, allowed]) => (
              <DreamingAction
                label={t(
                  `dreaming.scene.${label === "backfill" && props.dreamDiaryActionLoading ? "working" : label}`,
                )}
                disabled={
                  !props.access[allowed] || props.modeSaving || props.dreamDiaryActionLoading
                }
                onClick={() => props[onClick]()}
              />
            )}
          </For>
        </div>
      </div>
      <Show when={props.dreamDiaryActionMessage}>
        {(message) => (
          <div
            class={["callout", message().kind === "success" ? "success" : "danger"]}
            role="status"
          >
            <div class="row wrap items-center gap-2">
              <span>{message().text}</span>
              {props.dreamDiaryActionArchivePath ? (
                <DreamingAction
                  label={t("dreaming.wiki.copyArchivePath")}
                  disabled={props.dreamDiaryActionLoading}
                  onClick={() => props.onCopyDreamingArchivePath()}
                />
              ) : undefined}
            </div>
          </div>
        )}
      </Show>

      <DreamingRead on={props.selectedAgentId}>
        <div class="dreams-advanced__sections">
          <AdvancedEntryList
            titleKey={"dreaming.advanced.stagedTitle"}
            descriptionKey={"dreaming.advanced.stagedDescription"}
            emptyKey={"dreaming.advanced.emptyGrounded"}
            entries={groundedEntries()}
            controls={
              <DreamingAction
                label={t("dreaming.scene.clearGrounded")}
                disabled={
                  !props.access.canResetGroundedShortTerm ||
                  props.modeSaving ||
                  props.dreamDiaryActionLoading
                }
                onClick={() => props.onResetGroundedShortTerm()}
              />
            }
            badge={() => t("dreaming.advanced.originDailyLog")}
            meta={(entry) => [
              entry.groundedCount > 0
                ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
                : "",
              entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
              entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
            ]}
          />
          <AdvancedEntryList
            titleKey={"dreaming.advanced.shortTermTitle"}
            descriptionKey={"dreaming.advanced.shortTermDescription"}
            emptyKey={"dreaming.advanced.emptyShortTerm"}
            entries={waitingEntries()}
            controls={
              <div class="dreams-advanced__sort">
                <For
                  each={
                    [
                      ["recent", "dreaming.advanced.sortRecent"],
                      ["signals", "dreaming.advanced.sortSignals"],
                    ] as const
                  }
                >
                  {(entryValue) => {
                    const [sort, label] = entryValue;
                    return (
                      <button
                        class={[
                          "dreams-advanced__sort-btn",
                          state().advancedWaitingSort === sort &&
                            "dreams-advanced__sort-btn--active",
                        ]}
                        onClick={() => {
                          props.onViewStateChange((draft) => {
                            draft.advancedWaitingSort = sort;
                          });
                        }}
                      >
                        {t(label)}
                      </button>
                    );
                  }}
                </For>
              </div>
            }
            badge={describeWaitingEntryOrigin}
            meta={(entry) => [
              `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`,
              entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
              entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
              entry.groundedCount > 0
                ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
                : "",
              entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hit` : "",
            ]}
          />
          <AdvancedEntryList
            titleKey={"dreaming.advanced.promotedTitle"}
            descriptionKey={"dreaming.advanced.promotedDescription"}
            emptyKey={"dreaming.advanced.emptyPromoted"}
            entries={data().promotedEntries}
            badge={describeWaitingEntryOrigin}
            meta={(entry) => [
              entry.promotedAt
                ? `${t("dreaming.advanced.updatedPrefix")} ${formatCompactDateTime(entry.promotedAt)}`
                : "",
              entry.groundedCount > 0
                ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
                : "",
              entry.totalSignalCount > 0
                ? `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`
                : "",
            ]}
          />
        </div>
      </DreamingRead>
      <DreamingRead
        read={props.readStatus}
        on={props.selectedAgentId}
        errorClass="dreams__controls-error"
      />
      {props.statusError ? (
        <div class="dreams__controls-error">{props.statusError}</div>
      ) : undefined}
    </section>
  );
}

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

function DreamingDiarySection(props: DreamingProps) {
  const state = () => props.viewState;
  const activeDiarySubTab = createMemo(() => state().activeDiarySubTab);
  const selectedAgentId = createMemo(() => props.selectedAgentId);
  const initialLoading = createMemo(() =>
    activeDiarySubTab() === "dreams"
      ? props.dreamDiaryContent === null && props.dreamDiaryLoading
      : activeDiarySubTab() === "insights"
        ? props.wikiImportInsights === null && props.wikiImportInsightsLoading
        : props.wikiOverview === null && props.wikiOverviewLoading,
  );
  const content = createMemo(() => props.dreamDiaryContent);
  const entries = createMemo(() => {
    const current = content();
    return typeof current === "string" ? parseDiaryEntries(current).toReversed() : [];
  });
  const imports = () => props.wikiImportInsights;
  const overview = () => props.wikiOverview;
  const labels = createMemo(() =>
    activeDiarySubTab() === "dreams"
      ? entries().map((entry) => formatDiaryChipLabel(entry.date))
      : activeDiarySubTab() === "insights"
        ? (imports()?.clusters.map((cluster) => cluster.label) ?? [])
        : (overview()?.clusters.map((cluster) => cluster.label) ?? []),
  );
  const selectedPage = createMemo(() =>
    Math.max(0, Math.min(state().diaryPage, labels().length - 1)),
  );
  const diary = createMemo(
    () =>
      ({
        dreams: {
          loading: props.dreamDiaryLoading,
          refresh: props.onRefreshDiary,
          explainer: "dreaming.wiki.dreamsExplainer",
        },
        insights: {
          loading: props.wikiImportInsightsLoading,
          refresh: props.onRefreshImports,
          explainer: "dreaming.wiki.insightsExplainer",
        },
        wiki: {
          loading: props.wikiOverviewLoading,
          refresh: props.onRefreshWikiOverview,
          explainer: "dreaming.wiki.wikiExplainer",
        },
      })[activeDiarySubTab()],
  );
  const memoryWikiUnavailable = () => activeDiarySubTab() !== "dreams" && !props.memoryWikiEnabled;
  return (
    <section class="dreams-diary">
      <div class="dreams-diary__chrome">
        <div class="dreams-diary__header">
          <span class="dreams-diary__title">{t("dreaming.diary.title")}</span>
          <HubTabs<DreamingViewState["activeDiarySubTab"]>
            {...{
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
                props.onCloseWikiPreview();
                props.onViewStateChange((draft) => {
                  draft.activeDiarySubTab = tab;
                  draft.diaryPage = 0;
                });
              },
            }}
          />
          <DreamingAction
            label={
              memoryWikiUnavailable()
                ? t(props.configOpening ? "common.loading" : "dreaming.wiki.howToEnable")
                : activeDiarySubTab() === "dreams"
                  ? t(diary().loading ? "dreaming.diary.reloading" : "dreaming.diary.reload")
                  : diary().loading
                    ? "Reloading…"
                    : "Reload"
            }
            disabled={
              memoryWikiUnavailable()
                ? props.configOpening || !props.access.canOpenConfig
                : props.modeSaving || diary().loading
            }
            busy={memoryWikiUnavailable() && props.configOpening}
            onClick={() => {
              props.onViewStateChange((draft) => {
                draft.diaryPage = 0;
              });
              if (memoryWikiUnavailable()) {
                void props.onOpenConfig();
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
              props.onViewStateChange((draft) => {
                draft.diaryPage = index;
              });
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
                  label={t(props.configOpening ? "common.loading" : "dreaming.wiki.openConfig")}
                  disabled={props.configOpening || !props.access.canOpenConfig}
                  busy={props.configOpening}
                  onClick={() => void props.onOpenConfig()}
                />
              </div>
            </div>
          }
        >
          <DreamingRead
            on={[selectedAgentId(), activeDiarySubTab(), initialLoading()]}
            errorClass="dreams-diary__error"
            fallback={
              <DiaryEmpty
                message={
                  activeDiarySubTab() === "dreams"
                    ? t("dreaming.diary.reloading")
                    : activeDiarySubTab() === "insights"
                      ? t("dreaming.wiki.loadingInsights")
                      : t("dreaming.wiki.loadingWiki")
                }
              />
            }
          >
            {activeDiarySubTab() === "dreams" ? (
              <DreamDiaryContent
                entries={parseDiaryEntries(props.readDiary() ?? "").toReversed()}
                selectedPage={selectedPage()}
                missing={props.readDiary() === null}
              />
            ) : activeDiarySubTab() === "insights" ? (
              <ImportedInsightsContent
                owner={props}
                data={props.readImports()}
                selectedPage={selectedPage()}
              />
            ) : (
              <WikiOverviewContent
                owner={props}
                data={props.readOverview()}
                selectedPage={selectedPage()}
              />
            )}
          </DreamingRead>
        </Show>
      </div>
      <WikiPreviewOverlay {...props} />
    </section>
  );
}

registerSettingsEnglish();
registerDreamingEnglish();

export function renderDreaming(props: DreamingProps) {
  const state = () => props.viewState;
  const activeSubTab = () => state().activeSubTab;

  return (
    <div class="dreams-page">
      <div class="dreams__topbar">
        <HubTabs<DreamingViewState["activeSubTab"]>
          {...{
            id: "dreams",
            active: state().activeSubTab,
            tabs: [
              { value: "scene", label: t("dreaming.tabs.scene") },
              { value: "diary", label: t("dreaming.tabs.diary") },
              { value: "advanced", label: t("dreaming.tabs.advanced") },
            ],
            ariaLabel: t("memoryPage.tabs.dreams"),
            panelId: "dreams-panel",
            variant: "sub",
            onSelect: (tab) => {
              props.onViewStateChange((draft) => {
                draft.activeSubTab = tab;
              });
            },
          }}
        />
      </div>

      <div
        id="dreams-panel"
        class="dreams__panel"
        role="tabpanel"
        aria-labelledby={`dreams-tab-${activeSubTab()}`}
      >
        <Switch fallback={<DreamingAdvancedSection {...props} />}>
          <Match when={activeSubTab() === "scene"}>
            <DreamingScene {...props} />
          </Match>
          <Match when={activeSubTab() === "diary"}>
            <DreamingDiarySection {...props} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
