import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
import { cancelLayout, scheduleLayout } from "../../lib/layout-frame.ts";
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
  const filtered = createMemo(() => {
    const query = needle();
    const matches =
      !query && LOG_LEVELS.every((level) => props.levelFilters[level])
        ? null
        : (entry: LogRow) =>
            (!entry.level || props.levelFilters[entry.level]) &&
            (!query ||
              normalizeLowercaseStringOrEmpty(
                [entry.message, entry.subsystem, entry.raw].filter(Boolean).join(" "),
              ).includes(query));
    const rows: LogRow[] = [];
    const byKey = new Map<VirtualItem["key"], number>();
    for (const entry of props.entries) {
      if (matches && !matches(entry)) {
        continue;
      }
      byKey.set(entry.id, rows.length);
      rows.push(entry);
    }
    return { rows, byKey };
  });
  const rows = () => filtered().rows;
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
  const getItemKey = createMemo(() => {
    // Layout-only updates keep the extractor for this filtered snapshot.
    const staticRows = rows();
    return (index: number) => staticRows[index]!.id;
  });
  const [window, setWindow] = createSignal<{
    items: VirtualItem[];
    height: number;
    getItemKey: ((index: number) => VirtualItem["key"]) | null;
  }>({
    items: [],
    height: 0,
    getItemKey: null,
  });
  const publish = () =>
    setWindow({
      items: virtualizer.getVirtualItems(),
      height: virtualizer.getTotalSize(),
      getItemKey: virtualizer.options.getItemKey,
    });
  const scrollRequest = {};
  let readerScrollPending = false;
  let synchronizeScrollOffset: ((scrolling: boolean) => void) | undefined;
  const skipSizeAdjustment = () => false;
  const updateSizeAdjustment = (
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
    scrolling: boolean,
    autoFollow = props.autoFollow,
  ) => {
    // Measurement writes interrupt WebKit's wheel travel. Keep idle reader anchoring.
    instance.shouldAdjustScrollPositionOnItemSizeChange =
      scrolling && !autoFollow ? skipSizeAdjustment : undefined;
  };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => stream,
    initialOffset: () => stream.scrollTop,
    estimateSize: () => 44,
    observeElementRect,
    observeElementOffset: (instance, notify) => {
      const updateOffset = (offset: number, scrolling: boolean) => {
        updateSizeAdjustment(instance, scrolling);
        notify(offset, scrolling);
      };
      synchronizeScrollOffset = (scrolling) => updateOffset(stream.scrollTop, scrolling);
      return observeElementOffset(instance, (offset, scrolling) => {
        readerScrollPending = false;
        updateOffset(offset, scrolling);
      });
    },
    scrollToFn: elementScroll,
    overscan: 6,
    // The library retains the reader's keyed row when the oldest lines are trimmed.
    anchorTo: "end",
    scrollEndThreshold: 120,
    // Measure outside observer delivery so synchronous compensation can publish safely.
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  const beginReaderScroll = () => {
    cancelLayout(scrollRequest);
    readerScrollPending = true;
    virtualizer.cancelScroll();
  };
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    const unmount = mountVirtualizer();
    return () => {
      cancelLayout(scrollRequest);
      unmount();
    };
  });
  createLayoutMeasurement(
    () => ({
      rows: rows(),
      byKey: filtered().byKey,
      getItemKey: getItemKey(),
      autoFollow: props.autoFollow,
    }),
    (next) => {
      if (!next) {
        return;
      }
      // WebKit can expose a wheel offset before delivering its scroll event.
      // Anchor a trim to the reader's current position, not the previous event.
      if (readerScrollPending) {
        readerScrollPending = false;
        synchronizeScrollOffset?.(true);
      }
      for (const key of virtualizer.itemSizeCache.keys()) {
        if (!next.byKey.has(key)) {
          virtualizer.itemSizeCache.delete(key);
        }
      }
      updateSizeAdjustment(virtualizer, virtualizer.isScrolling, next.autoFollow);
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.rows.length,
        getItemKey: next.getItemKey,
        followOnAppend: next.autoFollow,
        // Follow-off readers pin measurements only once they reach the end.
        scrollEndThreshold: next.autoFollow ? 120 : 0,
      });
      publish();
    },
    { targets: () => [stream], changeTiming: "sync", fonts: true },
  );
  const windowHeight = createMemo(() => window().height);
  const windowItemKey = createMemo(() => window().getItemKey);
  createLayoutMeasurement(
    () => [windowHeight(), windowItemKey()],
    () => {
      // Apply append/trim anchors after Solid commits their spacer and row window.
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      // A retried compensation must be read back before another row measures from the old offset.
      synchronizeScrollOffset?.(virtualizer.isScrolling);
    },
    { targets: () => [stream], changeTiming: "sync" },
  );
  const rendered = createMemo(() =>
    window().items.flatMap((item) => {
      // A filter/trim can settle before its next measured range. Keep surviving keys only.
      const current = filtered();
      const index = current.byKey.get(item.key);
      return index === undefined ? [] : [{ row: current.rows[index]!, index, top: item.start }];
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
        class={["log-row", { "log-row--last": rowProps.item.index === rows().length - 1 }]}
        role="listitem"
        aria-posinset={rowProps.item.index + 1}
        aria-setsize={rows().length}
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
            disabled={rows().length === 0}
            onClick={() =>
              props.onExport(
                rows().map((entry) => entry.raw),
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
            props.onStreamRef?.(element, () =>
              scheduleLayout(scrollRequest, () => () => virtualizer.scrollToEnd()),
            );
          }}
          class="log-stream log-stream--windowed"
          role="region"
          aria-label={t("gatewayLogs.title")}
          tabindex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) < 2) {
              // Reaching the estimated bottom must survive the next wrapped-row measurements.
              virtualizer.scrollToEnd();
            }
          }}
          onWheel={beginReaderScroll}
          onTouchStart={beginReaderScroll}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home"].includes(event.key)) {
              beginReaderScroll();
            }
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
            {/* Rows must not extend the native scroll range before their spacer commits. */}
            <div
              role="list"
              style={{
                position: "relative",
                height: `${windowHeight()}px`,
                overflow: windowHeight() > 0 ? "clip" : undefined,
              }}
            >
              <For
                each={rendered()}
                keyed={(item) => item.row.id}
                fallback={
                  <Show when={rows().length === 0}>
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
