import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { PanelRefreshStatus as RefreshStatus } from "../../components/panel-refresh-status-state.ts";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsStatus,
  SettingsToggle,
} from "../../components/solid/settings-ui.tsx";
import { registerLogsEnglish } from "../../i18n/locales/en-logs.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { LOG_LEVELS, type LogEntry, type LogLevel } from "./log-lines.ts";

registerEnglishCatalog(registerLogsEnglish);

export type LogsReadCompletion = {
  promise: Promise<RefreshStatus | null>;
  quiet: boolean;
};

export type LogRow = LogEntry & { id: number };

export type LogsProps = {
  completion: LogsReadCompletion | null;
  refreshDisabled: boolean;
  status: RefreshStatus;
  file: string | null;
  entries: LogRow[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onStreamRef?: (element: HTMLDivElement, scrollToEnd: () => void) => void;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: JSX.EventHandler<HTMLDivElement, Event>;
};

function formatLogTime(value: string | null | undefined, formatter: Intl.DateTimeFormat) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date.getTime());
}

export function LogsView(props: LogsProps) {
  const read = createMemo(() =>
    props.completion?.promise.then((result) => {
      if (result?.error) {
        throw new Error(result.error);
      }
    }),
  );
  const readStatus = () => {
    read();
    return null;
  };
  const loading = () => !props.completion?.quiet && isPending(read);
  const refreshStatus = () => (
    // eslint-disable-next-line solid/no-react-specific-props -- The shared status API calls this prop className.
    <PanelRefreshStatus status={props.status} className="logs-refresh-status" />
  );
  const needle = createMemo(() => normalizeLowercaseStringOrEmpty(props.filterText));
  const filtered = createMemo(() =>
    props.entries.filter((entry) => {
      if (entry.level && !props.levelFilters[entry.level]) {
        return false;
      }
      if (!needle()) {
        return true;
      }
      return normalizeLowercaseStringOrEmpty(
        [entry.message, entry.subsystem, entry.raw].filter(Boolean).join(" "),
      ).includes(needle());
    }),
  );
  // Check system timezone on row updates without invalidating unchanged rows' timestamps.
  const timeFormatter = createMemo(
    () => {
      filtered();
      return new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" });
    },
    {
      equals: (previous, next) => {
        const before = previous.resolvedOptions();
        const after = next.resolvedOptions();
        return before.locale === after.locale && before.timeZone === after.timeZone;
      },
    },
  );
  const exportFileLabel = () =>
    needle() || LOG_LEVELS.some((level) => !props.levelFilters[level]) ? "filtered" : "visible";

  let stream: HTMLDivElement;
  const rowsByKey = createMemo(
    () =>
      new Map<VirtualItem["key"], { row: LogRow; index: number }>(
        filtered().map((row, index) => [row.id, { row, index }]),
      ),
  );
  const getItemKey = createMemo(() => {
    // Layout-only updates keep the extractor for this filtered snapshot.
    const staticRows = filtered();
    return (index: number) => staticRows[index]!.id;
  });
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => stream,
    initialOffset: () => stream.scrollTop,
    estimateSize: () => 44,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 6,
    // The library retains the reader's keyed row when the oldest lines are trimmed.
    anchorTo: "end",
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  createLayoutMeasurement(
    () => ({ rows: filtered(), byKey: rowsByKey(), getItemKey: getItemKey() }),
    (next) => {
      if (!next) {
        return;
      }
      for (const key of virtualizer.itemSizeCache.keys()) {
        if (!next.byKey.has(key)) {
          virtualizer.itemSizeCache.delete(key);
        }
      }
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.rows.length,
        getItemKey: next.getItemKey,
      });
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      publish();
    },
    { targets: () => [stream], changeTiming: "sync", fonts: true },
  );
  const rendered = createMemo(() =>
    window().items.flatMap((item) => {
      // A filter/trim can settle before its next measured range. Keep surviving keys only.
      const current = rowsByKey().get(item.key);
      return current ? [{ ...current, top: item.start }] : [];
    }),
  );
  function Row(rowProps: { item: { row: LogRow; index: number; top: number } }) {
    let element: HTMLDivElement;
    const row = createMemo(() => rowProps.item.row);
    onSettled(() => {
      virtualizer.measureElement(element);
      return () => virtualizer.measureElement(null);
    });
    return (
      <div
        ref={(node) => (element = node)}
        class={["log-row", { "log-row--last": rowProps.item.index === filtered().length - 1 }]}
        role="listitem"
        aria-posinset={rowProps.item.index + 1}
        aria-setsize={filtered().length}
        data-index={rowProps.item.index}
        style={{
          position: "absolute",
          width: "100%",
          top: "0",
          transform: `translateY(${rowProps.item.top}px)`,
        }}
      >
        <div class="log-time mono">{formatLogTime(row().time, timeFormatter())}</div>
        <div class={["log-level", row().level ?? ""]}>{row().level ?? ""}</div>
        <div class="log-subsystem mono">{row().subsystem ?? ""}</div>
        <div class="log-message mono">{row().message ?? row().raw}</div>
      </div>
    );
  }

  // Keep the fill-height flex chain from the workspace through the log stream.
  return (
    <>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("gatewayLogs.title")}</h2>
        <div class="settings-section__actions">
          <Loading
            fallback={
              <button class="btn" disabled>
                {props.completion?.quiet ? t("common.refresh") : t("common.loading")}
              </button>
            }
          >
            <button
              class="btn"
              disabled={props.refreshDisabled || isPending(read)}
              onClick={() => props.onRefresh()}
            >
              {loading() ? t("common.loading") : t("common.refresh")}
            </button>
          </Loading>
          <button
            class="btn"
            disabled={filtered().length === 0}
            onClick={() =>
              props.onExport(
                filtered().map((entry) => entry.raw),
                exportFileLabel(),
              )
            }
          >
            {t("gatewayLogs.exportButton", {
              label: t(`gatewayLogs.exportLabels.${exportFileLabel()}`),
            })}
          </button>
        </div>
      </div>
      <p class="settings-section__desc">{t("gatewayLogs.subtitle")}</p>
      <Show when={props.completion} keyed fallback={refreshStatus()}>
        {(completion) => (
          <Errored fallback={refreshStatus()}>
            <Loading on={completion} fallback={refreshStatus()}>
              {readStatus()}
              {refreshStatus()}
            </Loading>
          </Errored>
        )}
      </Show>
      <div class="settings-group logs-card">
        <SettingsRow
          title={t("gatewayLogs.filter")}
          description={props.file ? t("gatewayLogs.file", { file: props.file }) : undefined}
          control={
            <input
              class="settings-input"
              aria-label={t("gatewayLogs.filter")}
              value={props.filterText}
              onInput={(event) => props.onFilterTextChange(event.currentTarget.value)}
              placeholder={t("gatewayLogs.searchPlaceholder")}
            />
          }
        />
        <div class="settings-row">
          <div class="chip-row">
            <For each={LOG_LEVELS}>
              {(level) => (
                <label class={["chip log-chip", level]}>
                  <input
                    type="checkbox"
                    checked={props.levelFilters[level]}
                    onChange={(event) => props.onLevelToggle(level, event.currentTarget.checked)}
                  />{" "}
                  <span>{level}</span>
                </label>
              )}
            </For>
          </div>
          <div class="settings-row__control">
            <SettingsToggle
              checked={props.autoFollow}
              ariaLabel={t("gatewayLogs.autoFollow")}
              onChange={(next) => props.onToggleAutoFollow(next)}
            />
            <span class="settings-row__value">{t("gatewayLogs.autoFollow")}</span>
          </div>
        </div>
        <Show when={props.truncated}>
          <div class="settings-row">
            <SettingsStatus kind="warn" label={t("gatewayLogs.truncated")} />
          </div>
        </Show>
        <div
          ref={(element) => {
            stream = element;
            props.onStreamRef?.(element, () => virtualizer.scrollToEnd());
          }}
          class="log-stream log-stream--windowed"
          role="region"
          aria-label={t("gatewayLogs.title")}
          tabindex={0}
          onScroll={(event) => props.onScroll(event)}
          onKeyDown={(event) => {
            if (
              event.key === "End" &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              // Native End stops at the old height while wrapped rows are measured.
              event.preventDefault();
              virtualizer.scrollToEnd();
            }
          }}
        >
          <Show
            when={props.status.hasLoaded}
            fallback={
              <Loading fallback={<LoadingState />}>{loading() ? <LoadingState /> : null}</Loading>
            }
          >
            <div role="list" style={{ position: "relative", height: `${window().height}px` }}>
              <For
                each={rendered()}
                keyed={(item) => item.row.id}
                fallback={
                  <Show when={filtered().length === 0}>
                    <SettingsEmpty message={t("gatewayLogs.empty")} />
                  </Show>
                }
              >
                {(item) => <Row item={item()} />}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
