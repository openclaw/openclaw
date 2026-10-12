import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { createMemo, For, untrack } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DreamingEntry } from "./dreaming.ts";
import { DreamingAction, formatCompactDateTime } from "./view-shared.tsx";
import type { DreamingProps } from "./view-types.ts";

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

export function renderAdvancedSection(props: DreamingProps) {
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
