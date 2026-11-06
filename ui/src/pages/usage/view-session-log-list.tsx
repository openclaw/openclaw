import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createMsFormatter } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import type { ParsedSessionLog } from "./helpers.ts";
import { formatUsageTokens } from "./metrics.ts";

export type SessionLogRow = ParsedSessionLog & { id: number };

export function SessionLogList(props: {
  entries: SessionLogRow[];
  source: SessionLogRow[];
  expanded: boolean;
}) {
  const formatTimestamp = createMemo(() => createMsFormatter(undefined, t("common.na")));
  // Native disclosures keep individual choices while their rows leave the window.
  // Expand/Collapse All and a replacement conversation start a new set of choices.
  const disclosures = createMemo(() => ({
    source: props.source,
    expanded: props.expanded,
    choices: new Map<number, boolean>(),
  }));
  const windowed = () => props.entries.length > 50;
  const disclosureIndexes = createMemo(() =>
    props.entries.flatMap((entry, index) => (entry.toolInfo.tools.length ? [index] : [])),
  );
  let viewport!: HTMLDivElement;
  let focusedId: number | undefined;
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  let current: SessionLogRow[] = [];
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => viewport,
    estimateSize: () => 250,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 3,
    gap: 10,
    onChange: publish,
  });
  function pinDisclosures(focusable: number[]) {
    const focusIndex = focusable.findIndex((index) => current[index]!.id === focusedId);
    const pinned = [
      focusable[0],
      focusable.at(-1),
      ...focusable.slice(Math.max(0, focusIndex - 1), focusIndex + 2),
    ].filter((index) => index !== undefined);
    // Text-only messages have no tab stop. Keep neighboring disclosures mounted.
    virtualizer.setOptions({
      ...virtualizer.options,
      rangeExtractor: (range) =>
        [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted(
          (left, right) => left - right,
        ),
    });
  }
  onSettled(() => {
    const { _didMount: mount } = virtualizer;
    return mount();
  });
  createLayoutMeasurement(
    () => ({
      entries: props.entries,
      disclosures: disclosureIndexes(),
      windowed: windowed(),
    }),
    (next) => {
      if (!next) {
        return;
      }
      current = next.entries;
      virtualizer.setOptions({
        ...virtualizer.options,
        enabled: next.windowed,
        count: current.length,
        getItemKey: (index) => current[index]!.id,
      });
      pinDisclosures(next.disclosures);
      const { _willUpdate: update } = virtualizer;
      update();
      publish();
    },
    { targets: () => [viewport], changeTiming: "sync", fonts: true },
  );
  const entriesById = createMemo(
    () =>
      new Map<VirtualItem["key"], SessionLogRow>(props.entries.map((entry) => [entry.id, entry])),
  );
  const geometry = createMemo(() => new Map(window().items.map((item) => [item.key, item])));
  const visible = createMemo(() =>
    window().items.flatMap((item) => entriesById().get(item.key) ?? []),
  );
  createPendingFocus(
    () => ({ entries: visible(), focused: viewport?.ownerDocument.activeElement }),
    {
      requested: (next, previous) => previous !== undefined && next.entries !== previous.entries,
      focus: ({ focused }) => {
        if (!(focused instanceof HTMLElement) || !viewport.contains(focused)) {
          return;
        }
        // Keyed row moves can blur a retained disclosure; preserve newer user focus.
        queueMicrotask(() => {
          const doc = focused.ownerDocument;
          if (
            focused.isConnected &&
            (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)
          ) {
            focused.focus({ preventScroll: true });
          }
        });
      },
    },
  );

  function Entry(row: { entry: SessionLogRow; virtual?: boolean }) {
    let element!: HTMLDivElement;
    const item = () => (row.virtual ? geometry().get(row.entry.id) : undefined);
    onSettled(() => {
      if (row.virtual) {
        virtualizer.measureElement(element);
        return () => virtualizer.measureElement(null);
      }
      return undefined;
    });
    return (
      <div
        ref={(node) => (element = node)}
        class={["session-log-entry", row.entry.log.role === "user" ? "user" : "assistant"]}
        role="listitem"
        aria-posinset={(item()?.index ?? props.entries.indexOf(row.entry)) + 1}
        aria-setsize={props.entries.length}
        data-index={item()?.index}
        onFocusIn={() => {
          focusedId = row.entry.id;
          if (windowed()) {
            pinDisclosures(disclosureIndexes());
            publish();
          }
        }}
        style={
          item()
            ? {
                position: "absolute",
                width: "100%",
                top: "0",
                transform: `translateY(${item()!.start}px)`,
              }
            : undefined
        }
      >
        <div class="session-log-meta">
          <span class="session-log-role">
            {row.entry.log.role === "user"
              ? t("usage.details.you")
              : row.entry.log.role === "assistant"
                ? t("usage.overview.assistant")
                : t("usage.details.tool")}
          </span>
          <span>{formatTimestamp()(row.entry.log.timestamp)}</span>
          {row.entry.log.tokens ? (
            <span>{formatUsageTokens(row.entry.log.tokens)}</span>
          ) : undefined}
        </div>
        <div class="session-log-content">{row.entry.cleanContent}</div>
        <Show when={row.entry.toolInfo.tools.length > 0}>
          <details
            class="session-log-tools"
            open={disclosures().choices.get(row.entry.id) ?? disclosures().expanded}
            onToggle={(event) => disclosures().choices.set(row.entry.id, event.currentTarget.open)}
          >
            <summary>{row.entry.toolInfo.summary}</summary>
            <div class="session-log-tools-list">
              <For each={row.entry.toolInfo.tools}>
                {([name, count]) => (
                  <span class="session-log-tools-pill">
                    {name} × {count}
                  </span>
                )}
              </For>
            </div>
          </details>
        </Show>
      </div>
    );
  }

  return (
    <div
      ref={(node) => (viewport = node)}
      class={["session-logs-list", { "session-logs-list--windowed": windowed() }]}
      role="list"
      aria-label={t("usage.details.conversation")}
      tabindex={windowed() ? 0 : undefined}
    >
      <Show
        when={windowed()}
        fallback={
          <For
            each={props.entries}
            fallback={
              <div class="usage-empty-block usage-empty-block--compact">
                {t("usage.details.noMessagesMatch")}
              </div>
            }
          >
            {(entry) => <Entry entry={entry} />}
          </For>
        }
      >
        <div class="session-logs-window" style={{ height: `${window().height}px` }}>
          <For each={visible()}>{(entry) => <Entry entry={entry} virtual />}</For>
        </div>
      </Show>
    </div>
  );
}
