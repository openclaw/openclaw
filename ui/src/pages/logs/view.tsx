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
import { FloatingHeaderActions } from "../../components/solid/floating-header-actions.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsPageHeader,
  SettingsStatus,
  SettingsToggle,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerLogsEnglish } from "../../i18n/locales/en-logs.ts";
import { cancelLayout, scheduleLayout } from "../../lib/layout-frame.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { LOG_LEVELS, type LogEntry, type LogLevel } from "./log-lines.ts";

registerEnglishCatalog(registerLogsEnglish);

// Matches the phone rules in logs.css.
const PHONE_WIDTH_QUERY = "(max-width: 640px)";
const STREAM_PADDING_PX = 8;
// A reader this far above the end has left the live tail; a row of wheel jitter has not.
const FOLLOW_RELEASE_PX = 24;
// Momentum keeps delivering scroll events after the last wheel or touch input.
const READER_INTENT_MS = 200;

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

/** Column width for this locale's clock; CJK day periods are about two cells each. */
function logTimeColumnWidth(formatter: Intl.DateTimeFormat) {
  const sample = formatter.format(new Date(2026, 11, 31, 22, 22, 22));
  let cells = 0;
  for (const char of sample) {
    cells += char.charCodeAt(0) > 0x2e7f ? 2 : 1;
  }
  return `${cells}ch`;
}

function formatLogTime(value: string | null | undefined, formatter: Intl.DateTimeFormat) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date.getTime());
}

export function LogsView(props: LogsProps) {
  const phone = createMediaQuery(
    PHONE_WIDTH_QUERY,
    globalThis.matchMedia?.(PHONE_WIDTH_QUERY).matches ?? false,
  );
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
  const needle = createMemo(() =>
    normalizeLowercaseStringOrEmpty(props.filterText).normalize("NFC"),
  );
  const filtered = createMemo(() => {
    const query = needle();
    const levels = LOG_LEVELS.filter((level) => props.levelFilters[level]);
    const matches =
      !query && levels.length === LOG_LEVELS.length
        ? null
        : (entry: LogRow) =>
            (!entry.level || props.levelFilters[entry.level]) &&
            (!query ||
              normalizeLowercaseStringOrEmpty(
                [entry.message, entry.subsystem, entry.raw].filter(Boolean).join(" "),
              )
                .normalize("NFC")
                .includes(query));
    const rows: LogRow[] = [];
    const byKey = new Map<VirtualItem["key"], number>();
    for (const entry of props.entries) {
      if (matches && !matches(entry)) {
        continue;
      }
      byKey.set(entry.id, rows.length);
      rows.push(entry);
    }
    return { rows, byKey, filter: `${levels.join(",")}|${query}` };
  });
  const rows = () => filtered().rows;
  // Check system timezone on row updates without invalidating unchanged rows' timestamps.
  const timeFormatter = createMemo(
    () => {
      filtered();
      // Lines arrive seconds apart; a fixed-width clock also keeps the columns aligned.
      return new Intl.DateTimeFormat(getLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    },
    {
      equals: (previous, next) => {
        const before = previous.resolvedOptions();
        const after = next.resolvedOptions();
        return before.locale === after.locale && before.timeZone === after.timeZone;
      },
    },
  );
  const levelsFiltered = () => LOG_LEVELS.some((level) => !props.levelFilters[level]);
  const exportFileLabel = () => (needle() || levelsFiltered() ? "filtered" : "visible");
  const exportLabel = () =>
    t("gatewayLogs.exportButton", {
      label: t(`gatewayLogs.exportLabels.${exportFileLabel()}`),
    });
  const exportRows = () =>
    props.onExport(
      rows().map((entry) => entry.raw),
      exportFileLabel(),
    );
  const filterLabel = () => {
    const levels = LOG_LEVELS.filter((level) => props.levelFilters[level]).join(", ");
    return levelsFiltered() && levels ? levels : t("gatewayLogs.filter");
  };
  const filterName = () =>
    filterLabel() === t("gatewayLogs.filter")
      ? filterLabel()
      : `${t("gatewayLogs.filter")}: ${filterLabel()}`;

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
    const reading = scrolling && !autoFollow;
    instance.shouldAdjustScrollPositionOnItemSizeChange = reading ? skipSizeAdjustment : undefined;
    // The end anchor bypasses the size predicate; a negative distance disarms it during travel.
    const scrollEndThreshold = autoFollow ? 120 : reading ? -1 : 0;
    if (instance.options.scrollEndThreshold !== scrollEndThreshold) {
      instance.setOptions({ ...instance.options, scrollEndThreshold });
    }
  };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => stream,
    initialOffset: () => stream.scrollTop,
    estimateSize: () => (phone() ? 44 : 20),
    paddingStart: STREAM_PADDING_PX,
    paddingEnd: STREAM_PADDING_PX,
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
  let appliedFilter: string | undefined;
  // Only the reader's own scrolling moves the switch; appends, trims and measurements never do.
  let readerIntent = false;
  let readerHoldsPointer = false;
  let readerLeftEnd = false;
  let lastScrollTop = 0;
  let readerIntentTimer: ReturnType<typeof setTimeout> | undefined;
  const extendReaderIntent = () => {
    readerIntent = true;
    clearTimeout(readerIntentTimer);
    readerIntentTimer = setTimeout(() => {
      readerIntent = readerHoldsPointer;
    }, READER_INTENT_MS);
  };
  const beginReaderScroll = () => {
    cancelLayout(scrollRequest);
    readerScrollPending = true;
    virtualizer.cancelScroll();
    updateSizeAdjustment(virtualizer, true);
    extendReaderIntent();
  };
  let stopPointerListeners: (() => void) | undefined;
  const holdPointer = () => {
    stopPointerListeners?.();
    readerHoldsPointer = true;
    extendReaderIntent();
    const view = stream.ownerDocument;
    const release = (event: PointerEvent) => {
      if (event.type === "pointermove" && event.buttons !== 0) {
        return;
      }
      readerHoldsPointer = false;
      extendReaderIntent();
      stopPointerListeners?.();
    };
    const stopUp = listen(view, "pointerup", release);
    const stopCancel = listen(view, "pointercancel", release);
    // A press on a scrollbar may never deliver its release.
    const stopMove = listen(view, "pointermove", release);
    stopPointerListeners = () => {
      stopUp();
      stopCancel();
      stopMove();
    };
  };
  const followReader = (element: HTMLDivElement) => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const movedUp = element.scrollTop < lastScrollTop;
    lastScrollTop = element.scrollTop;
    if (readerIntent) {
      extendReaderIntent();
    }
    if (Math.abs(distance) < 2) {
      // Reaching the estimated bottom must survive the next wrapped-row measurements.
      virtualizer.scrollToEnd();
      if (readerIntent && readerLeftEnd && !props.autoFollow) {
        props.onToggleAutoFollow(true);
      }
      readerLeftEnd = false;
    } else if (readerIntent && distance > 0) {
      readerLeftEnd = true;
      if (movedUp && distance > FOLLOW_RELEASE_PX && props.autoFollow) {
        props.onToggleAutoFollow(false);
      }
    }
  };
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    const unmount = mountVirtualizer();
    return () => {
      cancelLayout(scrollRequest);
      stopPointerListeners?.();
      clearTimeout(readerIntentTimer);
      unmount();
    };
  });
  createLayoutMeasurement(
    () => ({
      rows: rows(),
      byKey: filtered().byKey,
      filter: filtered().filter,
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
      });
      publish();
      // A filter swaps the rows under the end anchor, so following has to find the end again.
      if (next.filter !== appliedFilter) {
        if (appliedFilter !== undefined && next.autoFollow) {
          scheduleLayout(scrollRequest, () => () => virtualizer.scrollToEnd());
        }
        appliedFilter = next.filter;
      }
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
        class={["log-row", row().level ?? ""]}
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
        <div class="log-time">{formatLogTime(row().time, timeFormatter())}</div>
        <div class="log-level">{row().level ?? ""}</div>
        <div class="log-subsystem" title={row().subsystem ?? undefined}>
          {row().subsystem ?? ""}
        </div>
        <div class="log-message">{row().message ?? row().raw}</div>
      </div>
    );
  }

  function Toolbar() {
    const actionsMenu = () => (
      <Loading
        fallback={
          <button
            type="button"
            class="btn logs-toolbar__button"
            aria-label={t("gatewayLogs.moreActions")}
            disabled
          >
            <Icon name="moreHorizontal" />
          </button>
        }
      >
        <Menu
          id="logs-actions"
          lazy
          pointerFocus="trigger"
          label={t("gatewayLogs.moreActions")}
          triggerClass="btn logs-toolbar__button"
          triggerAttributes={{ title: t("gatewayLogs.moreActions") }}
          trigger={<Icon name="moreHorizontal" />}
          placement="bottom-end"
          items={[
            {
              id: "refresh",
              label: loading() ? t("common.loading") : t("common.refresh"),
              icon: <Icon name="refresh" />,
              disabled: props.refreshDisabled || isPending(read),
            },
            {
              id: "export",
              label: exportLabel(),
              icon: <Icon name="download" />,
              disabled: rows().length === 0,
            },
          ]}
          onSelect={(item) => {
            if (item.id === "refresh") {
              props.onRefresh();
            } else {
              exportRows();
            }
          }}
        />
      </Loading>
    );
    return (
      <div class="logs-toolbar">
        <div class="logs-toolbar__search">
          <span class="logs-toolbar__search-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            type="search"
            class="settings-input"
            aria-label={t("gatewayLogs.searchPlaceholder")}
            value={props.filterText}
            onInput={(event) => props.onFilterTextChange(event.currentTarget.value)}
            placeholder={t("gatewayLogs.searchPlaceholder")}
          />
        </div>
        <Menu
          id="logs-levels"
          label={filterName()}
          triggerClass={[
            "btn logs-toolbar__button logs-toolbar__levels",
            { active: levelsFiltered() },
          ]}
          triggerAttributes={{ title: filterName() }}
          trigger={
            <>
              <Icon name="listFilter" />
              <span class="logs-toolbar__levels-label">{filterLabel()}</span>
            </>
          }
          placement="bottom-end"
          items={LOG_LEVELS.map((level) => ({
            id: level,
            label: level,
            labelClass: "mono",
            type: "checkbox" as const,
            checked: props.levelFilters[level],
            closeOnSelect: false,
          }))}
          onSelect={(item) => {
            const level = LOG_LEVELS.find((candidate) => candidate === item.id);
            if (level) {
              props.onLevelToggle(level, !props.levelFilters[level]);
            }
          }}
        />
        <label class="logs-toolbar__follow">
          <span>{t("gatewayLogs.autoFollow")}</span>
          <SettingsToggle
            checked={props.autoFollow}
            ariaLabel={t("gatewayLogs.autoFollow")}
            onChange={(next) => props.onToggleAutoFollow(next)}
          />
        </label>
        <Show when={phone()}>
          <FloatingHeaderActions fallback={actionsMenu()}>{actionsMenu()}</FloatingHeaderActions>
        </Show>
      </div>
    );
  }

  // Keep the fill-height flex chain from the workspace through the log stream.
  return (
    <>
      <SettingsPageHeader
        title={t("tabs.logs")}
        subtitle={t("gatewayLogs.subtitle")}
        actions={
          <Show when={!phone()}>
            <Loading
              fallback={
                <RefreshButton
                  label={t("common.refresh")}
                  busy={!props.completion?.quiet}
                  disabled
                  onClick={() => props.onRefresh()}
                />
              }
            >
              <RefreshButton
                label={t("common.refresh")}
                busy={loading()}
                disabled={props.refreshDisabled || isPending(read)}
                onClick={() => props.onRefresh()}
              />
            </Loading>
            <button class="btn" disabled={rows().length === 0} onClick={exportRows}>
              {exportLabel()}
            </button>
          </Show>
        }
      />
      <SettingsWorkspace fillHeight>
        <SettingsPage wide>
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
          <div class="logs-layout">
            <Toolbar />
            <div class="settings-group logs-card">
              <div
                ref={(element) => {
                  stream = element;
                  props.onStreamRef?.(element, () =>
                    scheduleLayout(scrollRequest, () => () => virtualizer.scrollToEnd()),
                  );
                }}
                class="log-stream log-stream--windowed"
                style={{ "--log-time-width": logTimeColumnWidth(timeFormatter()) }}
                role="region"
                aria-label={t("gatewayLogs.title")}
                tabindex={0}
                onScroll={(event) => followReader(event.currentTarget)}
                onWheel={beginReaderScroll}
                onTouchStart={beginReaderScroll}
                // Scrollbar and selection drags scroll with no wheel or touch to announce them.
                onPointerDown={holdPointer}
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
                    if (!props.autoFollow) {
                      props.onToggleAutoFollow(true);
                    }
                  }
                }}
              >
                <Show
                  when={props.status.hasLoaded}
                  fallback={
                    <Loading fallback={<LoadingState />}>
                      {loading() ? <LoadingState /> : null}
                    </Loading>
                  }
                >
                  {/* Rows must not extend the native scroll range before their spacer commits. */}
                  <div
                    role="list"
                    style={{
                      position: "relative",
                      height: `${windowHeight()}px`,
                      overflow: rows().length > 0 ? "clip" : undefined,
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
            <div class="logs-footer">
              <Show when={props.file}>
                {(file) => (
                  <span class="logs-footer__file">{t("gatewayLogs.file", { file: file() })}</span>
                )}
              </Show>
              <Show when={props.truncated}>
                <SettingsStatus kind="warn" label={t("gatewayLogs.truncated")} />
              </Show>
            </div>
          </div>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
