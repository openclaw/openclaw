import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, untrack } from "solid-js";
import { renderHubTabs } from "../../../components/hub-tabs.ts";
import { lobsterPetSeed } from "../../../components/lobster-pet-contract.ts";
import { createLobsterPetLook, renderLobsterSvg } from "../../../components/lobster-pet-look.ts";
import { LitContent } from "../../../components/solid/lit-content.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import "../../../components/modal-dialog.ts";
import { i18n } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/dreams.css";
import type {
  DreamingEntry,
  WikiImportInsights,
  WikiOverview,
  WikiPagePreview,
} from "./dreaming.ts";

registerSettingsEnglish();
registerDreamingEnglish();

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

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

export type DreamingProps = {
  access: {
    canOpenConfig: boolean;
    canBackfillDiary: boolean;
    canDedupeDreamDiary: boolean;
    canResetDiary: boolean;
    canResetGroundedShortTerm: boolean;
    canRepairDreamingArtifacts: boolean;
  };
  viewState: DreamingViewState;
  active: boolean;
  selectedAgentId: string;
  shortTermCount: number;
  promotedCount: number;
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  nextCycle: string | null;
  timezone: string | null;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiOverviewLoading: boolean;
  wikiOverviewError: string | null;
  wikiOverview: WikiOverview | null;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshWikiOverview: () => void;
  onOpenConfig: () => void;
  onOpenWikiPage: (lookup: string) => Promise<WikiPagePreview | null>;
  onBackfillDiary: () => void;
  onCopyDreamingArchivePath: () => void;
  onDedupeDreamDiary: () => void;
  onResetDiary: () => void;
  onResetGroundedShortTerm: () => void;
  onRepairDreamingArtifacts: () => void;
  onViewStateChange: () => void;
};

const DREAM_PHRASE_KEYS = [
  "dreaming.phrases.consolidatingMemories",
  "dreaming.phrases.tidyingKnowledgeGraph",
  "dreaming.phrases.replayingConversations",
  "dreaming.phrases.weavingShortTerm",
  "dreaming.phrases.defragmentingMemoryLane",
  "dreaming.phrases.filingLooseThoughts",
  "dreaming.phrases.connectingDots",
  "dreaming.phrases.compostingContext",
  "dreaming.phrases.alphabetizingSubconscious",
  "dreaming.phrases.promotingHunches",
  "dreaming.phrases.forgettingNoise",
  "dreaming.phrases.dreamingEmbeddings",
  "dreaming.phrases.reorganizingAttic",
  "dreaming.phrases.indexingDay",
  "dreaming.phrases.nurturingInsights",
  "dreaming.phrases.simmeringIdeas",
  "dreaming.phrases.whisperingVectorStore",
] as const;

const DREAM_PHASES = ["light", "deep", "rem"] as const;
const DREAM_ACTIONS = [
  ["dedupeDiary", "onDedupeDreamDiary", "canDedupeDreamDiary"],
  ["repairCache", "onRepairDreamingArtifacts", "canRepairDreamingArtifacts"],
  ["backfill", "onBackfillDiary", "canBackfillDiary"],
  ["reset", "onResetDiary", "canResetDiary"],
  ["clearGrounded", "onResetGroundedShortTerm", "canResetGroundedShortTerm"],
] as const;

const DREAM_SWAP_MS = 6_000;

export type DreamingViewState = {
  dreamIndex: number;
  dreamLastSwap: number;
  activeSubTab: "scene" | "diary" | "advanced";
  activeDiarySubTab: "dreams" | "insights" | "wiki";
  advancedWaitingSort: "recent" | "signals";
  expandedInsightCards: Set<string>;
  expandedWikiCards: Set<string>;
  diaryPage: number;
  wikiPreview: { page: WikiPagePreview; loading: boolean; error: string | null } | null;
};

export function createDreamingViewState(): DreamingViewState {
  return {
    dreamIndex: Math.floor(Math.random() * DREAM_PHRASE_KEYS.length),
    dreamLastSwap: 0,
    activeSubTab: "scene",
    activeDiarySubTab: "dreams",
    advancedWaitingSort: "recent",
    expandedInsightCards: new Set(),
    expandedWikiCards: new Set(),
    diaryPage: 0,
    wikiPreview: null,
  };
}

function currentDreamPhrase(state: DreamingViewState): string {
  const now = Date.now();
  if (now - state.dreamLastSwap > DREAM_SWAP_MS) {
    state.dreamLastSwap = now;
    state.dreamIndex = (state.dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[state.dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
}

const STARS: {
  top: number;
  left: number;
  size: number;
  delay: number;
  hue: "neutral" | "accent";
}[] = [
  { top: 8, left: 15, size: 3, delay: 0, hue: "neutral" },
  { top: 12, left: 72, size: 2, delay: 1.4, hue: "neutral" },
  { top: 22, left: 35, size: 3, delay: 0.6, hue: "accent" },
  { top: 18, left: 88, size: 2, delay: 2.1, hue: "neutral" },
  { top: 35, left: 8, size: 2, delay: 0.9, hue: "neutral" },
  { top: 45, left: 92, size: 2, delay: 1.7, hue: "neutral" },
  { top: 55, left: 25, size: 3, delay: 2.5, hue: "accent" },
  { top: 65, left: 78, size: 2, delay: 0.3, hue: "neutral" },
  { top: 75, left: 45, size: 2, delay: 1.1, hue: "neutral" },
  { top: 82, left: 60, size: 3, delay: 1.8, hue: "accent" },
  { top: 30, left: 55, size: 2, delay: 0.4, hue: "neutral" },
  { top: 88, left: 18, size: 2, delay: 2.3, hue: "neutral" },
];

export function renderDreaming(props: DreamingProps) {
  const state = untrack(() => props.viewState);
  const dreamText = createMemo(() => currentDreamPhrase(state));
  const activeSubTab = createMemo(() => state.activeSubTab);

  return (
    <div class="dreams-page">
      <div class="dreams__topbar">
        <LitContent
          content={() =>
            renderHubTabs({
              id: "dreams",
              active: state.activeSubTab,
              tabs: [
                { value: "scene", label: t("dreaming.tabs.scene") },
                { value: "diary", label: t("dreaming.tabs.diary") },
                { value: "advanced", label: t("dreaming.tabs.advanced") },
              ],
              ariaLabel: t("memoryPage.tabs.dreams"),
              panelId: "dreams-panel",
              variant: "sub",
              onSelect: (tab) => {
                state.activeSubTab = tab;
                props.onViewStateChange();
              },
            })
          }
        />
      </div>

      <div
        id="dreams-panel"
        class="dreams__panel"
        role="tabpanel"
        aria-labelledby={`dreams-tab-${activeSubTab()}`}
      >
        {activeSubTab() === "scene"
          ? renderScene(props, dreamText)
          : activeSubTab() === "diary"
            ? renderDiarySection(props)
            : renderAdvancedSection(props)}
      </div>
    </div>
  );
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

function renderScene(props: DreamingProps, dreamText: () => string) {
  // Keep the sleeper's seeded identity consistent with this agent's sidebar pet.
  const look = createMemo(() => createLobsterPetLook(lobsterPetSeed(props.selectedAgentId)));
  const style = () => `--lob-shell:${look().palette.shell};--lob-claw:${look().palette.claw}`;
  return (
    <section class={`dreams ${!props.active ? "dreams--idle" : ""}`}>
      <For each={STARS}>
        {(s) => (
          <div
            class="dreams__star"
            style={`
              top: ${s.top}%;
              left: ${s.left}%;
              width: ${s.size}px;
              height: ${s.size}px;
              background: ${s.hue === "accent" ? "var(--accent-muted)" : "var(--text)"};
              animation-delay: ${s.delay}s;
            `}
          />
        )}
      </For>

      <div class="dreams__moon" />

      {props.active ? (
        <>
          <div class="dreams__bubble">
            <span class="dreams__bubble-text">{dreamText()}</span>
          </div>
          <div
            class="dreams__bubble-dot"
            style="top: calc(50% - 160px); left: calc(50% - 120px); width: 12px; height: 12px; animation-delay: 0.2s;"
          />
          <div
            class="dreams__bubble-dot"
            style="top: calc(50% - 120px); left: calc(50% - 90px); width: 8px; height: 8px; animation-delay: 0.4s;"
          />
        </>
      ) : undefined}

      <div class="dreams__glow" />
      <div class="dreams__lobster" style={style()}>
        <LitContent content={() => renderLobsterSvg(look(), { sleeping: true })} />
      </div>
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>

      <div class="dreams__status">
        <span class="dreams__status-label">
          {props.active ? t("dreaming.status.active") : t("dreaming.status.idle")}
        </span>
        <div class="dreams__status-detail">
          <div class="dreams__status-dot" />
          <span>
            {props.promotedCount} {t("dreaming.status.promotedSuffix")}
            {props.nextCycle ? (
              <>
                {" "}
                · {t("dreaming.status.nextSweepPrefix")} {props.nextCycle}{" "}
              </>
            ) : undefined}
            {props.timezone ? <> · {props.timezone} </> : undefined}
          </span>
        </div>
      </div>

      <div class="dreams__phases">
        <For each={DREAM_PHASES}>
          {(phaseId) => {
            const phase = createMemo(() => props.phases?.[phaseId]);
            const enabled = () => phase()?.enabled === true;
            const status = () => {
              const current = phase();
              if (!current) {
                return "—";
              }
              if (!current.enabled) {
                return t("dreaming.phase.off");
              }
              return current.nextRunAtMs
                ? new Date(current.nextRunAtMs).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : "—";
            };
            return (
              <div
                class={[
                  "dreams__phase",
                  { "dreams__phase--off": phase() !== undefined && !enabled() },
                ]}
              >
                <div class={["dreams__phase-dot", { "dreams__phase-dot--on": enabled() }]} />
                <span class="dreams__phase-name">{t(`dreaming.phase.${phaseId}`)}</span>
                <span class="dreams__phase-next">{status()}</span>
              </div>
            );
          }}
        </For>
      </div>

      {props.statusError ? (
        <div class="dreams__controls-error">{props.statusError}</div>
      ) : undefined}
    </section>
  );
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function formatCompactDateTime(value: string): string {
  const parsed = parseDateStringTimestampMs(value);
  if (parsed === undefined) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatWikiCount(
  kind: "page" | "claimRow" | "openQuestion" | "contradiction",
  count: number,
): string {
  return t(`dreaming.wiki.counts.${kind}${count === 1 ? "One" : "s"}`, { count: String(count) });
}

const WIKI_OVERVIEW_PAGE_GROUPS = [
  ["source", "sources"],
  ["synthesis", "syntheses"],
  ["report", "reports"],
  ["entity", "entities"],
  ["concept", "concepts"],
] as const;

function formatWikiOverviewPageBreakdown(pageCounts: WikiOverview["pageCounts"]): string {
  const parts = WIKI_OVERVIEW_PAGE_GROUPS.map(([kind, group]) => {
    const count = pageCounts[kind];
    return count > 0
      ? t("dreaming.wiki.pageGroupSummary", {
          label: t(`dreaming.wiki.pageGroups.${group}`),
          count: formatWikiCount("page", count),
        })
      : null;
  }).filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("; ") : t("dreaming.wiki.noPagesYet");
}

function formatWikiOverviewClusterSummary(cluster: WikiOverview["clusters"][number]): string {
  const parts = [
    t("dreaming.wiki.sectionPageSummary", {
      label: cluster.label,
      count: formatWikiCount("page", cluster.itemCount),
    }),
  ];
  if (cluster.claimCount > 0) {
    parts.push(formatWikiCount("claimRow", cluster.claimCount));
  }
  if (cluster.questionCount > 0) {
    const questionPageCount = cluster.items.filter((item) => item.questionCount > 0).length;
    const questionCount = formatWikiCount("openQuestion", cluster.questionCount);
    parts.push(
      questionPageCount > 0
        ? t("dreaming.wiki.questionCountOnPages", {
            questionCount,
            pageCount: formatWikiCount("page", questionPageCount),
          })
        : questionCount,
    );
  }
  if (cluster.contradictionCount > 0) {
    parts.push(formatWikiCount("contradiction", cluster.contradictionCount));
  }
  return parts.join(" · ");
}

function toggleExpandedCard(bucket: Set<string>, key: string, onChange: () => void): void {
  if (bucket.has(key)) {
    bucket.delete(key);
  } else {
    bucket.add(key);
  }
  onChange();
}

async function openWikiPreview(lookup: string, props: DreamingProps): Promise<void> {
  const state = untrack(() => props.viewState);
  const request: NonNullable<DreamingViewState["wikiPreview"]> = {
    page: { title: pathDisplayName(lookup), path: lookup, content: "" },
    loading: true,
    error: null,
  };
  state.wikiPreview = request;
  props.onViewStateChange();
  try {
    const preview = await props.onOpenWikiPage(lookup);
    if (state.wikiPreview !== request) {
      return;
    }
    if (!preview) {
      request.error = t("dreaming.wiki.pageNotFound", { lookup });
      return;
    }
    request.page = { ...preview };
  } catch (error) {
    if (state.wikiPreview === request) {
      request.error = formatUiError(error);
    }
  } finally {
    if (state.wikiPreview === request) {
      request.loading = false;
      props.onViewStateChange();
    }
  }
}

function closeWikiPreview(props: DreamingProps): void {
  props.viewState.wikiPreview = null;
  props.onViewStateChange();
}

function renderWikiPreviewOverlay(props: DreamingProps) {
  const preview = createMemo(() => props.viewState.wikiPreview);
  return (
    <Show when={preview()} keyed>
      {(request) => {
        const current = () => props.viewState.wikiPreview ?? request;
        return (
          <openclaw-modal-dialog
            prop:label={current().page.title || t("dreaming.wiki.previewFallbackTitle")}
            style="--openclaw-modal-width: 1120px"
            onModal-cancel={() => closeWikiPreview(props)}
          >
            <div class="dreams-diary__preview-panel">
              <div class="dreams-diary__preview-header">
                <div>
                  <div class="dreams-diary__preview-title">
                    {current().page.title || t("dreaming.wiki.previewFallbackTitle")}
                  </div>
                  <div class="dreams-diary__preview-meta">
                    {current().page.path}{" "}
                    {current().page.updatedAt
                      ? ` · ${formatCompactDateTime(current().page.updatedAt)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn--subtle btn--sm"
                  onClick={() => closeWikiPreview(props)}
                >
                  {t("dreaming.wiki.close")}
                </button>
              </div>
              <div class="dreams-diary__preview-body">
                {current().loading ? (
                  <div class="dreams-diary__empty-text">{t("dreaming.wiki.loadingPage")}</div>
                ) : current().error ? (
                  <div class="dreams-diary__error">{current().error}</div>
                ) : (
                  <>
                    {current().page.truncated === true ? (
                      <div class="dreams-diary__preview-hint">
                        {current().page.totalLines != null
                          ? t("dreaming.wiki.previewTruncatedWithTotal", {
                              count: String(current().page.totalLines),
                            })
                          : t("dreaming.wiki.previewTruncated")}
                      </div>
                    ) : undefined}
                    <pre class="dreams-diary__preview-pre">{current().page.content}</pre>
                  </>
                )}
              </div>
            </div>
          </openclaw-modal-dialog>
        );
      }}
    </Show>
  );
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

function DreamingAction(props: {
  label: string;
  disabled: boolean;
  onClick: (event: Event) => void;
}) {
  return (
    <button
      class="btn btn--subtle btn--sm"
      disabled={props.disabled}
      onClick={(event) => props.onClick(event)}
    >
      {props.label}
    </button>
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
              const badge = createMemo(() => params.badge?.(entry()));
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

function renderAdvancedSection(props: DreamingProps) {
  const state = untrack(() => props.viewState);
  const groundedEntries = createMemo(() =>
    props.shortTermEntries.filter((entry) => entry.groundedCount > 0),
  );
  const waitingEntries = createMemo(() =>
    props.shortTermEntries.toSorted(
      state.advancedWaitingSort === "signals"
        ? compareWaitingEntryBySignals
        : compareWaitingEntryByRecency,
    ),
  );
  const description = () => t("dreaming.advanced.description");
  const summary = () =>
    [
      `${groundedEntries().length} ${t("dreaming.advanced.summaryFromDailyLog")}`,
      `${props.shortTermCount} ${t("dreaming.advanced.summaryWaiting")}`,
      `${props.promotedCount} ${t("dreaming.advanced.summaryPromotedToday")}`,
    ].join(" · ");

  return (
    <section class="dreams-advanced">
      <div class="dreams-advanced__header">
        <div class="dreams-advanced__intro">
          <span class="dreams-advanced__eyebrow">{t("dreaming.advanced.eyebrow")}</span>
          <h2 class="dreams-advanced__title">{t("dreaming.advanced.title")}</h2>
          {description() ? <p class="dreams-advanced__description">{description()}</p> : undefined}
          <div class="dreams-advanced__summary">{summary()}</div>
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
      {props.dreamDiaryActionMessage ? (
        <div
          class={`callout ${props.dreamDiaryActionMessage.kind === "success" ? "success" : "danger"}`}
          role="status"
        >
          <div class="row wrap items-center gap-2">
            <span>{props.dreamDiaryActionMessage.text}</span>
            {props.dreamDiaryActionArchivePath ? (
              <DreamingAction
                label={t("dreaming.wiki.copyArchivePath")}
                disabled={props.dreamDiaryActionLoading}
                onClick={() => props.onCopyDreamingArchivePath()}
              />
            ) : undefined}
          </div>
        </div>
      ) : undefined}

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
                      class={`dreams-advanced__sort-btn ${state.advancedWaitingSort === sort ? "dreams-advanced__sort-btn--active" : ""}`}
                      onClick={() => {
                        state.advancedWaitingSort = sort;
                        props.onViewStateChange();
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
          entries={props.promotedEntries}
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

      {props.statusError ? (
        <div class="dreams__controls-error">{props.statusError}</div>
      ) : undefined}
    </section>
  );
}

type ImportedInsightItem = WikiImportInsights["clusters"][number]["items"][number];
type WikiPageItem = WikiOverview["clusters"][number]["items"][number];
type WikiInsightCard =
  | { kind: "import"; item: ImportedInsightItem }
  | { kind: "wiki"; item: WikiPageItem };

function renderInsightList(labelKey: string, entries: string[]) {
  return entries.length > 0 ? (
    <div class="dreams-diary__insight-list">
      <strong>{t(labelKey)}</strong>
      <For each={entries} keyed={false}>
        {(entry) => <p class="dreams-diary__insight-line">• {entry()}</p>}
      </For>
    </div>
  ) : undefined;
}

function renderInsightDetail(labelKey: string, value: string | undefined) {
  return value ? (
    <p class="dreams-diary__insight-line">
      <strong>{t(labelKey)}</strong>
      {value}
    </p>
  ) : undefined;
}

function renderWikiInsightBody(card: WikiInsightCard, expanded: boolean) {
  if (card.kind === "import") {
    const item = card.item;
    return (
      <>
        <p class="dreams-diary__insight-line">{item.summary}</p>
        {renderInsightList("dreaming.wiki.candidateSignals", item.candidateSignals)}
        {renderInsightList("dreaming.wiki.corrections", item.correctionSignals)}
        {expanded ? (
          <div class="dreams-diary__insight-list">
            <strong>{t("dreaming.wiki.importDetails")}</strong>
            {renderInsightDetail("dreaming.wiki.startedWith", item.firstUserLine)}
            {renderInsightDetail(
              "dreaming.wiki.endedOn",
              item.lastUserLine !== item.firstUserLine ? item.lastUserLine : undefined,
            )}
            {renderInsightDetail(
              "dreaming.wiki.messages",
              `${t("dreaming.wiki.counts.userMessages", {
                count: String(item.userMessageCount),
              })} · ${t("dreaming.wiki.counts.assistantMessages", {
                count: String(item.assistantMessageCount),
              })}`,
            )}
            {renderInsightDetail("dreaming.wiki.riskReasons", item.riskReasons.join(", "))}
            {renderInsightDetail("dreaming.wiki.labels", item.labels.join(", "))}
          </div>
        ) : undefined}
        {item.preferenceSignals.length > 0 ? (
          <div class="dreams-diary__insight-signals">
            <For each={item.preferenceSignals} keyed={false}>
              {(signal) => <span class="dreams-diary__insight-signal">{signal()}</span>}
            </For>
          </div>
        ) : undefined}
      </>
    );
  }

  const item = card.item;
  return (
    <>
      {item.snippet ? <p class="dreams-diary__insight-line">{item.snippet}</p> : undefined}
      {renderInsightList("dreaming.wiki.claims", item.claims)}
      {renderInsightList("dreaming.wiki.openQuestions", item.questions)}
      {renderInsightList("dreaming.wiki.contradictions", item.contradictions)}
      {expanded ? (
        <div class="dreams-diary__insight-list">
          <strong>{t("dreaming.wiki.pageDetails")}</strong>
          {renderInsightDetail("dreaming.wiki.wikiPage", item.pagePath)}
          {renderInsightDetail("dreaming.wiki.id", item.id)}
        </div>
      ) : undefined}
    </>
  );
}

function WikiInsightCard(props: { owner: DreamingProps; card: WikiInsightCard }) {
  const owner = untrack(() => props.owner);
  const state = untrack(() => owner.viewState);
  const item = () => props.card.item;
  const expandedCards = () =>
    props.card.kind === "import" ? state.expandedInsightCards : state.expandedWikiCards;
  const expanded = createMemo(() => expandedCards().has(item().pagePath));
  const badgeClass = () => {
    const card = props.card;
    return card.kind === "import" ? card.item.riskLevel : "wiki";
  };
  const badgeLabel = () => {
    const card = props.card;
    return card.kind === "import"
      ? t(
          card.item.digestStatus === "withheld"
            ? "dreaming.wiki.risk.needsReview"
            : `dreaming.wiki.risk.${card.item.riskLevel}`,
        )
      : t(`dreaming.wiki.pageTypes.${card.item.kind}`);
  };
  const metadata = () => {
    const card = props.card;
    return card.kind === "import"
      ? card.item.activeBranchMessages > 0
        ? ` · ${t("dreaming.wiki.counts.messages", { count: String(card.item.activeBranchMessages) })}`
        : ""
      : ` · ${card.item.pagePath}`;
  };
  return (
    <article
      class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
      data-import-page={props.card.kind === "import" ? item().pagePath : undefined}
      data-wiki-page={props.card.kind === "wiki" ? item().pagePath : undefined}
      onClick={() => {
        const card = props.card;
        if (card.kind === "wiki" && card.item.kind === "report") {
          void openWikiPreview(card.item.pagePath, owner);
          return;
        }
        toggleExpandedCard(expandedCards(), item().pagePath, owner.onViewStateChange);
      }}
    >
      <div class="dreams-diary__insight-topline">
        <div class="dreams-diary__insight-title">{item().title}</div>
        <span class={`dreams-diary__insight-badge dreams-diary__insight-badge--${badgeClass()}`}>
          {badgeLabel()}
        </span>
      </div>
      <div class="dreams-diary__insight-meta">
        {item().updatedAt
          ? formatCompactDateTime(item().updatedAt!)
          : pathDisplayName(item().pagePath)}
        {metadata()}
      </div>
      {renderWikiInsightBody(props.card, expanded())}
      <div class="dreams-diary__insight-actions">
        <DreamingAction
          label={t(expanded() ? "dreaming.wiki.hideDetails" : "dreaming.wiki.details")}
          disabled={false}
          onClick={(event) => {
            event.stopPropagation();
            toggleExpandedCard(expandedCards(), item().pagePath, owner.onViewStateChange);
          }}
        />
        <DreamingAction
          label={t(
            props.card.kind === "import"
              ? "dreaming.wiki.openSourcePage"
              : "dreaming.wiki.openWikiPage",
          )}
          disabled={false}
          onClick={(event) => {
            event.stopPropagation();
            void openWikiPreview(item().pagePath, owner);
          }}
        />
      </div>
    </article>
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

function DiaryEmpty(props: { message: string; hint?: string; children?: JSX.Element }) {
  return (
    <div class="dreams-diary__empty">
      {props.children}
      <div class="dreams-diary__empty-text">{props.message}</div>
      <Show when={props.hint}>
        {(hint) => <div class="dreams-diary__empty-hint">{hint()}</div>}
      </Show>
    </div>
  );
}

function WikiClusterArticle(props: {
  date: string;
  truncated: boolean;
  returnedItems: number;
  totalItems: number;
  prose: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <article class="dreams-diary__entry">
      <div class="dreams-diary__accent" />
      <div class="dreams-diary__date">{props.date}</div>
      <Show when={props.truncated}>
        <p class="dreams-diary__para dreams-diary__bounded-result">
          {t("dreaming.wiki.boundedResults", {
            returned: props.returnedItems.toLocaleString(i18n.getLocale()),
            total: props.totalItems.toLocaleString(i18n.getLocale()),
          })}
        </p>
      </Show>
      <div class="dreams-diary__prose">{props.prose}</div>
      <div class="dreams-diary__insights">{props.children}</div>
    </article>
  );
}

function ImportedInsightsContent(props: {
  owner: DreamingProps;
  data: WikiImportInsights | null;
  selectedPage: number;
  loading: boolean;
}) {
  const cluster = createMemo(() => props.data?.clusters[props.selectedPage]);
  const returnedItems = createMemo(
    () => props.data?.clusters.reduce((total, item) => total + item.itemCount, 0) ?? 0,
  );
  const date = (current: WikiImportInsights["clusters"][number]) => {
    const metadata = [
      t("dreaming.wiki.counts.chats", { count: String(current.itemCount) }),
      ...(current.highRiskCount > 0
        ? [t("dreaming.wiki.counts.sensitive", { count: String(current.highRiskCount) })]
        : []),
      ...(current.preferenceSignalCount > 0
        ? [t("dreaming.wiki.counts.signals", { count: String(current.preferenceSignalCount) })]
        : []),
    ];
    return `${current.label} · ${metadata.join(" · ")}`;
  };
  const summary = (current: WikiImportInsights["clusters"][number]) =>
    [
      t("dreaming.wiki.importedClusterSummary", { label: current.label.toLowerCase() }),
      ...(current.withheldCount > 0
        ? [
            t(
              current.withheldCount === 1
                ? "dreaming.wiki.withheldDigestOne"
                : "dreaming.wiki.withheldDigests",
              { count: String(current.withheldCount) },
            ),
          ]
        : []),
    ].join(" ");
  return (
    <Show
      when={cluster()}
      fallback={
        <DiaryEmpty
          message={t(props.loading ? "dreaming.wiki.loadingInsights" : "dreaming.wiki.noInsights")}
          hint={props.loading ? undefined : t("dreaming.wiki.noInsightsHint")}
        />
      }
    >
      {(current) => (
        <WikiClusterArticle
          date={date(current())}
          truncated={props.data?.truncated ?? false}
          returnedItems={returnedItems()}
          totalItems={props.data?.totalItems ?? 0}
          prose={<p class="dreams-diary__para">{summary(current())}</p>}
        >
          <For each={current().items} keyed={(item) => item.pagePath}>
            {(item) => (
              <WikiInsightCard owner={props.owner} card={{ kind: "import", item: item() }} />
            )}
          </For>
        </WikiClusterArticle>
      )}
    </Show>
  );
}

function WikiOverviewContent(props: {
  owner: DreamingProps;
  data: WikiOverview | null;
  selectedPage: number;
  loading: boolean;
}) {
  const cluster = createMemo(() => props.data?.clusters[props.selectedPage]);
  const returnedItems = createMemo(
    () => props.data?.clusters.reduce((total, item) => total + item.itemCount, 0) ?? 0,
  );
  const date = () => {
    const metadata = (
      [
        ["page", props.data?.totalPages ?? 0],
        ["claimRow", props.data?.totalClaims ?? 0],
        ["openQuestion", props.data?.totalQuestions ?? 0],
        ["contradiction", props.data?.totalContradictions ?? 0],
      ] as const
    )
      .filter(([kind, count]) => kind === "page" || count > 0)
      .map(([kind, count]) => formatWikiCount(kind, count));
    return `${t("dreaming.wiki.vault")} · ${metadata.join(" · ")}`;
  };
  return (
    <Show
      when={cluster()}
      fallback={
        <DiaryEmpty
          message={t(props.loading ? "dreaming.wiki.loadingWiki" : "dreaming.wiki.emptyWiki")}
          hint={props.loading ? undefined : t("dreaming.wiki.emptyWikiHint")}
        />
      }
    >
      {(current) => (
        <WikiClusterArticle
          date={date()}
          truncated={props.data?.truncated ?? false}
          returnedItems={returnedItems()}
          totalItems={props.data?.totalItems ?? 0}
          prose={
            <>
              <p class="dreams-diary__para">
                {t("dreaming.wiki.fullVaultBreakdown", {
                  breakdown: props.data
                    ? formatWikiOverviewPageBreakdown(props.data.pageCounts)
                    : t("dreaming.wiki.noPagesYet"),
                })}
              </p>
              <p class="dreams-diary__para">
                {t("dreaming.wiki.selectedSection", {
                  summary: formatWikiOverviewClusterSummary(current()),
                })}
                {current().updatedAt
                  ? ` ${t("dreaming.wiki.latestUpdate", { date: formatCompactDateTime(current().updatedAt!) })}`
                  : ""}
              </p>
            </>
          }
        >
          <For each={current().items} keyed={(item) => item.pagePath}>
            {(item) => (
              <WikiInsightCard owner={props.owner} card={{ kind: "wiki", item: item() }} />
            )}
          </For>
        </WikiClusterArticle>
      )}
    </Show>
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

function renderDiarySection(props: DreamingProps) {
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
              content={() =>
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
