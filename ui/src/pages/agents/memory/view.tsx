import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { IconButton } from "../../../components/solid/icon-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { RefreshButton } from "../../../components/solid/refresh-button.tsx";
import { SettingsSelect } from "../../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggleRow,
} from "../../../components/solid/settings-ui.tsx";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import "../../../styles/dreams.css";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DreamingEntry, DreamingReviewPanel, DreamingViewState } from "./dreaming.ts";
import { DreamingScene } from "./view-scene.tsx";
import { DiaryEmpty, DreamingRead, formatCompactDateTime } from "./view-shared.tsx";
import type { DreamingProps } from "./view-types.ts";
import { ImportedInsightsContent, WikiPreviewOverlay, WikiOverviewContent } from "./view-wiki.tsx";

/** One sweep runs these in order, so that is the order they read in. */
const SWEEP_PHASES = ["light", "rem", "deep"] as const;

const MAINTENANCE_ACTIONS = [
  ["dedupeDiary", "onDedupeDreamDiary", "canDedupeDreamDiary"],
  ["repairCache", "onRepairDreamingArtifacts", "canRepairDreamingArtifacts"],
  ["backfill", "onBackfillDiary", "canBackfillDiary"],
  ["reset", "onResetDiary", "canResetDiary"],
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

function DreamingControls(props: DreamingProps) {
  const data = () => props.readStatusData();
  const description = () => {
    if (props.header.configuredDreaming.engineOff) {
      return t("dreaming.header.engineOff");
    }
    const scope = t("dreaming.toggleConfirmation.subtitle");
    if (!props.active) {
      return scope;
    }
    const parts = [
      data().nextCycle ? `${t("dreaming.status.nextSweepPrefix")} ${data().nextCycle}` : null,
      data().timezone,
      data().promotedCount > 0
        ? `${data().promotedCount} ${t("dreaming.status.promotedSuffix")}`
        : null,
    ].filter(Boolean);
    return parts.join(" · ") || scope;
  };
  return (
    <SettingsGroup>
      <SettingsToggleRow
        title={t("dreaming.header.toggle")}
        description={
          <span class="dreams-controls__status">
            <DreamingRead on={props.selectedAgentId}>{description()}</DreamingRead>
          </span>
        }
        checked={props.active}
        disabled={!props.header.canUpdateConfig || props.header.configuredDreaming.engineOff}
        saving={props.header.loading}
        // The owner asks for confirmation first; the switch moves once the write lands.
        onChange={(enabled) => {
          props.onSetEnabled(enabled);
          return false;
        }}
        actions={
          <RefreshButton
            label={t("dreaming.header.refresh")}
            busy={props.header.refreshLoading}
            disabled={props.header.loading || props.dreamDiaryLoading}
            onClick={() => props.onRefresh()}
          />
        }
      />
      <div class="settings-row dreams-controls__phases-row">
        <div class="settings-row__text">
          <span class="settings-row__title">{t("dreaming.phase.title")}</span>
        </div>
        <div class="settings-row__control dreams-controls__phases">
          <For each={SWEEP_PHASES}>
            {(phaseId) => (
              <DreamingRead on={props.selectedAgentId}>
                <span
                  class={[
                    "dreams-controls__phase",
                    {
                      "dreams-controls__phase--off": data().phases?.[phaseId]?.enabled === false,
                    },
                  ]}
                >
                  <SettingsStatus
                    kind={data().phases?.[phaseId]?.enabled === true ? "ok" : "muted"}
                    label={t(`dreaming.phase.${phaseId}`)}
                  />
                </span>
              </DreamingRead>
            )}
          </For>
        </div>
      </div>
      <DreamingRead
        read={props.readStatus}
        on={props.selectedAgentId}
        errorClass="dreams__controls-error"
      />
      {props.statusError ? (
        <div class="dreams__controls-error">{props.statusError}</div>
      ) : undefined}
    </SettingsGroup>
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

/** Turns the diary's pages: newest first, with every date a jump away. */
function DiaryPager(props: {
  entries: DiaryEntry[];
  selectedPage: number;
  onSelect: (index: number) => void;
}) {
  const selected = () => props.entries[props.selectedPage];
  return (
    <div class="dreams-diary__pager">
      <Show
        when={props.entries.length > 1}
        fallback={
          <Show when={selected()?.date}>
            {(date) => <time class="dreams-diary__date">{date()}</time>}
          </Show>
        }
      >
        <SettingsSelect
          class="dreams-diary__dates"
          aria-label={t("dreaming.diary.title")}
          value={String(props.selectedPage)}
          options={props.entries.map((entry, index) => ({
            value: String(index),
            label: entry.date ? formatDiaryDate(entry.date) : String(props.entries.length - index),
          }))}
          onChange={(event) => props.onSelect(Number(event.currentTarget.value))}
        />
        <span class="dreams-diary__steps">
          <IconButton
            icon="chevronLeft"
            label={t("dreaming.diary.older")}
            disabled={props.selectedPage >= props.entries.length - 1}
            onClick={() => props.onSelect(props.selectedPage + 1)}
          />
          <IconButton
            icon="chevronRight"
            label={t("dreaming.diary.newer")}
            disabled={props.selectedPage <= 0}
            onClick={() => props.onSelect(props.selectedPage - 1)}
          />
        </span>
      </Show>
    </div>
  );
}

/** The select's room is small on a phone, and a diary date reads fine shortened. */
function formatDiaryDate(date: string): string {
  const parsed = parseDateStringTimestampMs(date);
  if (parsed === undefined) {
    return date;
  }
  const entry = new Date(parsed);
  return entry.toLocaleString([], {
    month: "short",
    day: "numeric",
    // Most entries are recent; the year only earns its width when it differs.
    ...(entry.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" as const }),
    hour: "numeric",
    minute: "2-digit",
  });
}

function DreamDiaryContent(props: {
  entries: DiaryEntry[];
  selectedPage: number;
  missing: boolean;
  onSelect: (index: number) => void;
}) {
  const selected = createMemo(() => props.entries[props.selectedPage]);
  return (
    <Show
      when={selected()}
      fallback={
        <DiaryEmpty
          message={t(props.missing ? "dreaming.diary.noDreamsYet" : "dreaming.diary.waitingTitle")}
          hint={t(props.missing ? "dreaming.diary.noDreamsHint" : "dreaming.diary.waitingHint")}
        />
      }
    >
      <article class="dreams-diary__entry">
        <DiaryPager
          entries={props.entries}
          selectedPage={props.selectedPage}
          onSelect={props.onSelect}
        />
        {/* Keyed by entry so each turned page replays its reveal; the pager keeps focus. */}
        <Show when={selected()} keyed>
          {(entry) => (
            <div class="dreams-diary__prose">
              <For each={flattenDiaryBody(entry.body)} keyed={false}>
                {(para, index) => (
                  <MarkdownHtml
                    as="p"
                    class="dreams-diary__para"
                    style={{ "animation-delay": `${0.1 + index * 0.15}s` }}
                    markdown={para()}
                  />
                )}
              </For>
            </div>
          )}
        </Show>
      </article>
    </Show>
  );
}

function DreamingDiarySection(props: DreamingProps) {
  const state = () => props.viewState;
  const initialLoading = createMemo(
    () => props.dreamDiaryContent === null && props.dreamDiaryLoading,
  );
  return (
    <section class="dreams-diary">
      <SettingsSection title={t("dreaming.diary.title")}>
        <DreamingRead
          on={[props.selectedAgentId, initialLoading()]}
          errorClass="dreams-diary__error"
          fallback={<DiaryEmpty message={t("dreaming.diary.reloading")} />}
        >
          {(() => {
            const entries = createMemo(() =>
              parseDiaryEntries(props.readDiary() ?? "").toReversed(),
            );
            return (
              <DreamDiaryContent
                entries={entries()}
                selectedPage={Math.max(0, Math.min(state().diaryPage, entries().length - 1))}
                missing={props.readDiary() === null}
                onSelect={(index) => {
                  props.onViewStateChange((draft) => {
                    draft.diaryPage = index;
                  });
                }}
              />
            );
          })()}
        </DreamingRead>
      </SettingsSection>
    </section>
  );
}

function ReviewRow(props: {
  owner: DreamingProps;
  panel: DreamingReviewPanel;
  title: string;
  description: string;
  count?: number;
  children?: JSX.Element;
}) {
  const open = () => props.owner.viewState.openReviewPanel === props.panel;
  const panelId = () => `dreams-review-${props.panel}`;
  return (
    <>
      <button
        type="button"
        class="settings-row settings-row--nav dreams-review__row"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={panelId()}
        onClick={() => {
          props.owner.onViewStateChange((draft) => {
            draft.openReviewPanel = open() ? null : props.panel;
          });
        }}
      >
        <span class="settings-row__text">
          <span class="settings-row__title">{props.title}</span>
          <span class="settings-row__desc">{props.description}</span>
        </span>
        <span class="settings-row__control">
          <Show when={props.count}>
            <span class="settings-row__value">{props.count}</span>
          </Show>
          <span class="settings-row__chevron">
            <Icon name="chevronRight" />
          </span>
        </span>
      </button>
      <Show when={open()}>
        <div id={panelId()} class="dreams-review__panel">
          {props.children}
        </div>
      </Show>
    </>
  );
}

function ReviewEntries(props: {
  entries: DreamingEntry[];
  emptyKey: string;
  meta: (entry: DreamingEntry) => string[];
}) {
  return (
    <Show when={props.entries.length > 0} fallback={<SettingsEmpty message={t(props.emptyKey)} />}>
      <For each={props.entries} keyed={(entry) => entry.key}>
        {(entry) => (
          <article class="dreams-review__entry" data-entry-key={entry().key}>
            <p class="dreams-review__snippet">{entry().snippet}</p>
            <p class="dreams-review__meta">
              <code>{formatRange(entry().path, entry().startLine, entry().endLine)}</code>
              {props
                .meta(entry())
                .filter((part) => part.length > 0)
                .map((part) => ` · ${part}`)
                .join("")}
            </p>
          </article>
        )}
      </For>
    </Show>
  );
}

function MaintenanceMenu(props: DreamingProps) {
  const id = createUniqueId();
  const items = (): MenuEntry[] =>
    MAINTENANCE_ACTIONS.map(([label, , allowed]) => ({
      id: label,
      label: t(`dreaming.scene.${label}`),
      disabled: !props.access[allowed] || props.modeSaving || props.dreamDiaryActionLoading,
    }));
  return (
    <Menu
      id={id}
      lazy
      class="dreams-review__menu"
      label={t("browser.moreActions")}
      placement="bottom-end"
      pointerFocus="trigger"
      triggerClass="oc-icon-button"
      trigger={<Icon name="moreHorizontal" />}
      items={items()}
      onSelect={(item) => {
        const action = MAINTENANCE_ACTIONS.find(([label]) => label === item.id);
        if (action) {
          props[action[1]]();
        }
      }}
    />
  );
}

function DreamingReview(props: DreamingProps) {
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
  return (
    <SettingsSection
      title={t("dreaming.advanced.eyebrow")}
      actions={
        <>
          <Show when={props.dreamDiaryActionLoading}>
            <SettingsStatus kind="running" label={t("dreaming.scene.working")} />
          </Show>
          <MaintenanceMenu {...props} />
        </>
      }
      notice={
        <Show when={props.dreamDiaryActionMessage}>
          {(message) => (
            <InlineAlert tone={message().kind === "success" ? "success" : "danger"} role="status">
              <div class="row wrap items-center gap-2">
                <span>{message().text}</span>
                {props.dreamDiaryActionArchivePath ? (
                  <button
                    class="btn btn--subtle btn--sm"
                    disabled={props.dreamDiaryActionLoading}
                    onClick={() => props.onCopyDreamingArchivePath()}
                  >
                    {t("dreaming.wiki.copyArchivePath")}
                  </button>
                ) : undefined}
              </div>
            </InlineAlert>
          )}
        </Show>
      }
    >
      <DreamingRead on={props.selectedAgentId} fallback={<SettingsLoadingSkeleton rows={3} />}>
        <ReviewRow
          owner={props}
          panel="waiting"
          title={t("dreaming.advanced.shortTermTitle")}
          description={t("dreaming.advanced.shortTermDescription")}
          count={data().shortTermCount}
        >
          <Show when={waitingEntries().length > 1}>
            <div class="dreams-review__tools">
              <SettingsSegmented<DreamingViewState["advancedWaitingSort"]>
                value={state().advancedWaitingSort}
                ariaLabel={t("dreaming.advanced.shortTermTitle")}
                options={[
                  { value: "recent", label: t("dreaming.advanced.sortRecent") },
                  { value: "signals", label: t("dreaming.advanced.sortSignals") },
                ]}
                onChange={(sort) => {
                  props.onViewStateChange((draft) => {
                    draft.advancedWaitingSort = sort;
                  });
                }}
              />
            </div>
          </Show>
          <ReviewEntries
            entries={waitingEntries()}
            emptyKey="dreaming.advanced.emptyShortTerm"
            meta={(entry) => [
              describeWaitingEntryOrigin(entry),
              `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`,
              entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
              entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
              entry.groundedCount > 0
                ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
                : "",
              entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hit` : "",
            ]}
          />
        </ReviewRow>
        <ReviewRow
          owner={props}
          panel="promotions"
          title={t("dreaming.advanced.promotedTitle")}
          description={t("dreaming.advanced.promotedDescription")}
          count={data().promotedEntries.length}
        >
          <ReviewEntries
            entries={data().promotedEntries}
            emptyKey="dreaming.advanced.emptyPromoted"
            meta={(entry) => [
              describeWaitingEntryOrigin(entry),
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
        </ReviewRow>
        <ReviewRow
          owner={props}
          panel="dailyLog"
          title={t("dreaming.advanced.stagedTitle")}
          description={t("dreaming.advanced.stagedDescription")}
          count={groundedEntries().length}
        >
          <Show when={groundedEntries().length > 0}>
            <div class="dreams-review__tools">
              <button
                class="btn btn--sm"
                disabled={
                  !props.access.canResetGroundedShortTerm ||
                  props.modeSaving ||
                  props.dreamDiaryActionLoading
                }
                onClick={() => props.onResetGroundedShortTerm()}
              >
                {t("dreaming.scene.clearGrounded")}
              </button>
            </div>
          </Show>
          <ReviewEntries
            entries={groundedEntries()}
            emptyKey="dreaming.advanced.emptyGrounded"
            meta={(entry) => [
              t("dreaming.advanced.originDailyLog"),
              entry.groundedCount > 0
                ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
                : "",
              entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
              entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
            ]}
          />
        </ReviewRow>
      </DreamingRead>
      <Show
        when={props.memoryWikiEnabled}
        fallback={
          <SettingsRow
            title={t("dreaming.wiki.unavailable")}
            description={
              <>
                {t("dreaming.wiki.unavailablePluginPrefix")} <code>memory-wiki</code>{" "}
                {t("dreaming.wiki.unavailablePluginSuffix")} {t("dreaming.wiki.enablePrefix")}{" "}
                <code>plugins.entries.memory-wiki.enabled = true</code>
                {t("dreaming.wiki.enableSuffix")}
              </>
            }
            control={
              <button
                class="btn btn--sm"
                disabled={props.configOpening || !props.access.canOpenConfig}
                aria-busy={props.configOpening ? "true" : undefined}
                onClick={() => void props.onOpenConfig()}
              >
                {t(props.configOpening ? "common.loading" : "dreaming.wiki.openConfig")}
              </button>
            }
          />
        }
      >
        <ReviewRow
          owner={props}
          panel="insights"
          title={t("dreaming.wiki.insightsTab")}
          description={t("dreaming.wiki.insightsExplainer")}
        >
          <DreamingRead
            on={[
              props.selectedAgentId,
              props.wikiImportInsights === null && props.wikiImportInsightsLoading,
            ]}
            errorClass="dreams-diary__error"
            fallback={<DiaryEmpty message={t("dreaming.wiki.loadingInsights")} />}
          >
            <ImportedInsightsContent owner={props} data={props.readImports()} />
          </DreamingRead>
        </ReviewRow>
        <ReviewRow
          owner={props}
          panel="wiki"
          title={t("dreaming.wiki.wikiTab")}
          description={t("dreaming.wiki.wikiExplainer")}
        >
          <DreamingRead
            on={[props.selectedAgentId, props.wikiOverview === null && props.wikiOverviewLoading]}
            errorClass="dreams-diary__error"
            fallback={<DiaryEmpty message={t("dreaming.wiki.loadingWiki")} />}
          >
            <WikiOverviewContent owner={props} data={props.readOverview()} />
          </DreamingRead>
        </ReviewRow>
      </Show>
    </SettingsSection>
  );
}

registerSettingsEnglish();
registerDreamingEnglish();

export function renderDreaming(props: DreamingProps) {
  return (
    <div class="settings-page dreams-page">
      <div class="dreams-page__stage">
        <DreamingScene {...props} />
        <DreamingControls {...props} />
      </div>
      <DreamingDiarySection {...props} />
      <DreamingReview {...props} />
      <WikiPreviewOverlay {...props} />
    </div>
  );
}
