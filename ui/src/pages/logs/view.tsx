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
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
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
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { LOG_LEVELS, type LogEntry, type LogLevel } from "./log-lines.ts";

registerEnglishCatalog(registerLogsEnglish);

// Matches the phone rules in logs.css.
const PHONE_WIDTH_QUERY = "(max-width: 640px)";

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
    const matches =
      !query && LOG_LEVELS.every((level) => props.levelFilters[level])
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
  const levelChips = () => (
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
  );
  const autoFollowToggle = () => (
    <SettingsToggle
      checked={props.autoFollow}
      ariaLabel={t("gatewayLogs.autoFollow")}
      onChange={(next) => props.onToggleAutoFollow(next)}
    />
  );

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
    updateSizeAdjustment(virtualizer, true);
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
        class="log-row"
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

  function PhoneToolbar() {
    let trigger!: HTMLButtonElement;
    let popover!: PopoverHandle;
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
            aria-label={t("gatewayLogs.filter")}
            value={props.filterText}
            onInput={(event) => props.onFilterTextChange(event.currentTarget.value)}
            placeholder={t("gatewayLogs.searchPlaceholder")}
          />
        </div>
        <button
          ref={(node) => {
            trigger = node;
          }}
          type="button"
          class={["btn logs-toolbar__button", { active: levelsFiltered() }]}
          title={t("gatewayLogs.filter")}
          aria-label={t("gatewayLogs.filter")}
          aria-haspopup="dialog"
          aria-controls="logs-filter-popover"
          aria-expanded="false"
          onClick={() => popover.overlay.request(!popover.overlay.open)}
        >
          <Icon name="listFilter" />
        </button>
        <Popover
          ref={(handle) => (popover = handle)}
          id="logs-filter-popover"
          class="logs-filter-popover"
          label={t("gatewayLogs.filter")}
          anchor={trigger}
          placement="bottom-end"
        >
          <div class="logs-filter">
            <div class="logs-filter__levels">{levelChips()}</div>
            <div class="logs-filter__follow">
              <span>{t("gatewayLogs.autoFollow")}</span>
              {autoFollowToggle()}
            </div>
            <Show when={props.file}>
              {(file) => <p class="logs-filter__file">{t("gatewayLogs.file", { file: file() })}</p>}
            </Show>
          </div>
        </Popover>
        <FloatingHeaderActions fallback={actionsMenu()}>{actionsMenu()}</FloatingHeaderActions>
      </div>
    );
  }

  // Keep the fill-height flex chain from the workspace through the log stream.
  return (
    <>
      <Show when={!phone()}>
        <div class="settings-section__header">
          <h2 class="settings-section__heading">{t("gatewayLogs.title")}</h2>
          <div class="settings-section__actions">
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
          </div>
        </div>
      </Show>
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
        <Show when={!phone()} fallback={<PhoneToolbar />}>
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
            <div class="chip-row">{levelChips()}</div>
            <div class="settings-row__control">
              {autoFollowToggle()}
              <span class="settings-row__value">{t("gatewayLogs.autoFollow")}</span>
            </div>
          </div>
        </Show>
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
