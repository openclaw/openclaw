import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { presenceViewerLabel } from "../../lib/presence-users.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { type SessionRowGroup, UNGROUPED_ID } from "../../lib/sessions/grouping.ts";
import { getAgentIdentity, SessionRows, sessionsTableColumnCount } from "./session-row.tsx";
import { categoryDropHandlers } from "./sessions-filters.tsx";
import type { SessionsProps } from "./view-types.ts";

function sessionGroupLabel(group: SessionRowGroup, props: SessionsProps): string {
  const { id } = group;
  if (props.groupBy === "date") {
    const labels: Record<string, string> = {
      today: "sessionsView.dateToday",
      yesterday: "sessionsView.dateYesterday",
      week: "sessionsView.dateThisWeek",
      older: "sessionsView.dateOlder",
    };
    return t(labels[id] ?? "sessionsView.dateNoActivity");
  }
  if (id === UNGROUPED_ID) {
    return t("sessionsView.ungrouped");
  }
  if (props.groupBy === "agent") {
    const identity = getAgentIdentity(props.agentIdentityById, id);
    const name = normalizeOptionalString(identity?.name);
    if (name) {
      const emoji = normalizeOptionalString(identity?.emoji);
      return emoji ? `${emoji} ${name}` : name;
    }
  }
  if (props.groupBy === "person") {
    const actor = group.rows[0]?.owner?.actor;
    return actor?.identity?.type === "profile"
      ? presenceViewerLabel({ id: actor.identity.id, name: actor.label?.trim() || undefined })
      : actor?.label?.trim() || id;
  }
  return id;
}

function renderGroupHeaderRow(group: SessionRowGroup, props: SessionsProps, index: number) {
  const label = sessionGroupLabel(group, props);
  const count = t(
    group.rows.length === 1 ? "sessionsView.groupRowCountOne" : "sessionsView.groupRowCount",
    { count: String(group.rows.length) },
  );
  const drop = categoryDropHandlers(props, group.id === UNGROUPED_ID ? null : group.id);
  return (
    <tr
      class="session-group-row"
      aria-rowindex={index}
      onDragOver={drop.dragover}
      onDragLeave={drop.dragleave}
      onDrop={drop.drop}
    >
      <td colspan={sessionsTableColumnCount(props)}>
        <div class="session-group-row__header">
          <span class="session-group-row__icon" aria-hidden="true">
            <Icon name="folder" />
          </span>
          <span class="session-group-row__label">{label}</span>
          <span class="session-group-row__count">{count}</span>
        </div>
      </td>
    </tr>
  );
}

export type SessionEntry = { key: string; row?: GatewaySessionRow; group?: SessionRowGroup };

// The page and its selection stay complete; only table row lifetimes are windowed.
export function SessionWindow(props: SessionsProps & { entries: SessionEntry[] }) {
  let start: HTMLTableSectionElement;
  let scroller: HTMLElement | null = null;
  let current: SessionEntry[] = [];
  let focusedKey: string | undefined;
  let previousExpandedKey: string | null = null;
  let synchronizeScrollOffset: (() => void) | undefined;
  const entries = createMemo(() => props.entries);
  const expandedKey = createMemo(() => props.expandedSessionKey);
  const menuKey = createMemo(() => props.sessionMenu?.key);
  // The default 25-row page costs less to render than to measure and window.
  const windowed = createMemo(() => entries().length > 25);
  const columnCount = createMemo(() => sessionsTableColumnCount(props));
  const getItemKey = createMemo(() => {
    const staticEntries = entries();
    return (index: number) => staticEntries[index]!.key;
  });
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLElement, HTMLTableSectionElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: (index) => (current[index]?.group ? 44 : index === current.length - 1 ? 44 : 45),
    observeElementRect,
    observeElementOffset: (instance, notify) => {
      synchronizeScrollOffset = () =>
        notify(instance.scrollElement?.scrollTop ?? 0, instance.isScrolling);
      return observeElementOffset(instance, notify);
    },
    scrollToFn: elementScroll,
    overscan: 3,
    onChange: publish,
  });
  const pinFocus = (pinnedExpandedKey: string | null, pinnedMenuKey: string | undefined) => {
    const index = current.findIndex((entry) => entry.key === focusedKey);
    const expanded = current.findIndex((entry) => entry.row?.key === pinnedExpandedKey);
    const menu = current.findIndex((entry) => entry.row?.key === pinnedMenuKey);
    const first = current.findIndex((entry) => Boolean(entry.row));
    const last = current.findLastIndex((entry) => Boolean(entry.row));
    const previous = current.findLastIndex(
      (entry, position) => position < index && Boolean(entry.row),
    );
    const next = current.findIndex((entry, position) => position > index && Boolean(entry.row));
    const pinned = [
      0,
      first,
      last,
      current.length - 1,
      previous,
      index,
      next,
      expanded,
      menu,
    ].filter((item) => item >= 0 && item < current.length);
    virtualizer.setOptions({
      ...virtualizer.options,
      rangeExtractor: (range) =>
        [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted((a, b) => a - b),
    });
  };
  onSettled(() => {
    const { _didMount: mount } = virtualizer;
    return mount();
  });
  createLayoutMeasurement(
    () => ({
      entries: entries(),
      windowed: windowed(),
      getItemKey: getItemKey(),
      expanded: expandedKey(),
      menu: menuKey(),
    }),
    (next) => {
      if (!next) {
        return;
      }
      if (
        previousExpandedKey &&
        (previousExpandedKey !== next.expanded ||
          !next.entries.some((entry) => entry.row?.key === previousExpandedKey))
      ) {
        // The old panel may unmount before its collapsed height can be measured.
        const index = current.findIndex((entry) => entry.row?.key === previousExpandedKey);
        if (index >= 0) {
          virtualizer.resizeItem(index, virtualizer.options.estimateSize(index));
        }
      }
      previousExpandedKey = next.expanded;
      current = next.entries;
      virtualizer.setOptions({
        ...virtualizer.options,
        enabled: next.windowed && Boolean(scroller),
        count: current.length,
        getItemKey: next.getItemKey,
      });
      pinFocus(next.expanded, next.menu);
      const { _willUpdate: update } = virtualizer;
      update();
      publish();
    },
    { targets: () => [], measureWithoutTarget: true, changeTiming: "sync" },
  );
  // Inventory changes reuse the viewport geometry; only layout invalidation reads it again.
  createLayoutMeasurement(
    () => ({ windowed: windowed(), columns: columnCount() }),
    (next) => {
      if (!next?.windowed) {
        return undefined;
      }
      scroller = start.closest<HTMLElement>(".data-table-container");
      const margin = scroller
        ? start.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : 0;
      return () => {
        virtualizer.setOptions({
          ...virtualizer.options,
          enabled: Boolean(scroller),
          scrollMargin: margin,
          scrollPaddingStart: margin,
        });
        const { _willUpdate: update } = virtualizer;
        update();
        publish();
      };
    },
    {
      targets: (next) => (next?.windowed ? [start, ...(scroller ? [scroller] : [])] : []),
      changeTiming: "sync",
      fonts: true,
    },
  );
  createLayoutMeasurement(
    () => window().height,
    () => {
      const { _willUpdate: update } = virtualizer;
      update();
    },
    { targets: () => [start], changeTiming: "sync" },
  );
  const indexed = createMemo(() => {
    let rowIndex = 2;
    return new Map(
      entries().map((entry, index) => {
        const item = { entry, index, rowIndex };
        rowIndex += 1 + Number(entry.row?.key === expandedKey());
        return [entry.key, item] as const;
      }),
    );
  });
  const visible = createMemo(() => {
    if (!windowed()) {
      return entries();
    }
    if (!window().items.length) {
      return entries().slice(0, 12);
    }
    return window().items.flatMap((item) => indexed().get(String(item.key))?.entry ?? []);
  });
  const visibleKeys = createMemo(() => new Set(visible().map((entry) => entry.key)));
  const geometry = createMemo(
    () =>
      new Map(
        window().items.map((item, index, items) => [
          item.key,
          {
            before: item.start - (index ? items[index - 1]!.end : virtualizer.options.scrollMargin),
            after:
              index === items.length - 1
                ? window().height - item.end + virtualizer.options.scrollMargin
                : 0,
          },
        ]),
      ),
  );
  function Spacer(spacer: { height: number }) {
    return (
      <Show when={spacer.height > 0}>
        <tr class="session-window-spacer" aria-hidden="true">
          <td
            colspan={sessionsTableColumnCount(props)}
            style={{ height: `${spacer.height}px`, padding: 0, border: 0 }}
          />
        </tr>
      </Show>
    );
  }
  function Entry(item: { entry: SessionEntry }) {
    let element: HTMLTableSectionElement;
    const position = () => indexed().get(item.entry.key)!;
    const expanded = createMemo(() => expandedKey() === item.entry.row?.key);
    function Content() {
      const before = createMemo(() =>
        windowed() ? (geometry().get(item.entry.key)?.before ?? 0) : 0,
      );
      const after = createMemo(() =>
        windowed() ? (geometry().get(item.entry.key)?.after ?? 0) : 0,
      );
      function Measurement() {
        // Measure the row and its optional details together after the estimated first paint.
        createLayoutMeasurement(
          () => ({
            index: position().index,
            expanded: expanded(),
            before: before(),
            after: after(),
          }),
          (next) => {
            if (!next) {
              return undefined;
            }
            const size = element.getBoundingClientRect().height - next.before - next.after;
            return () => virtualizer.resizeItem(next.index, size);
          },
          { targets: () => [element] },
        );
        return null;
      }
      return (
        <>
          <Show when={windowed()}>
            <Measurement />
          </Show>
          <Spacer height={before()} />
          {item.entry.row ? (
            <SessionRows {...props} row={item.entry.row} rowIndex={position().rowIndex} />
          ) : (
            renderGroupHeaderRow(item.entry.group!, props, position().rowIndex)
          )}
          <Spacer height={after()} />
        </>
      );
    }
    return (
      <tbody
        ref={(node) => (element = node)}
        onFocusIn={() => {
          if (focusedKey === item.entry.key) {
            return;
          }
          focusedKey = item.entry.key;
          if (windowed()) {
            synchronizeScrollOffset?.();
            pinFocus(expandedKey(), menuKey());
            publish();
            // Native focus scrolls the control; a tall details panel must not align its bottom.
            if (!expanded()) {
              virtualizer.scrollToIndex(position().index);
            }
          }
        }}
      >
        <Show when={visibleKeys().has(item.entry.key)}>
          <Content />
        </Show>
      </tbody>
    );
  }
  return (
    <>
      <tbody ref={(node) => (start = node)} aria-hidden="true">
        <tr class="session-window-spacer">
          <td colspan={sessionsTableColumnCount(props)} style={{ padding: 0, border: 0 }} />
        </tr>
      </tbody>
      {/* Stable empty slots avoid moving a focused tbody when the window changes. */}
      <For each={entries()} keyed={(entry) => entry.key}>
        {(entry) => <Entry entry={entry()} />}
      </For>
    </>
  );
}
