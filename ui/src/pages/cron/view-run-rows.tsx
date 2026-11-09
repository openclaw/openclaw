import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled } from "solid-js";
import type { CronRunLogEntry } from "../../api/types.ts";
import type { createCompactMsFormatter } from "../../lib/format.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { CompactRun, LegacyRun } from "./view-run-row.tsx";
import type { CronRunsSectionProps } from "./view-runs.tsx";

const runKey = (entry: CronRunLogEntry) => `${entry.jobId}:${entry.ts}:${entry.runId ?? ""}`;

/** The existing scrollport owns navigation; Cron still owns all page admission and data. */
export function RunRows(
  props: CronRunsSectionProps & {
    rows: CronRunLogEntry[];
    formatTimestamp: ReturnType<typeof createCompactMsFormatter>;
  },
) {
  let list!: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  let synchronizeScrollOffset: (() => void) | undefined;
  let focusedKey: string | undefined;
  let current: CronRunLogEntry[] = [];
  let requestingMore = false;
  const elements = new Set<HTMLDivElement>();
  const windowed = () => props.rows.length > 20;
  const getItemKey = createMemo(() => {
    const rows = props.rows;
    return (index: number) => runKey(rows[index]!);
  });
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  let committedWindow: ReturnType<typeof window> | undefined;
  const loadNearEnd = () => {
    // The keyboard destinations include the final row, independently of the viewport.
    const end = virtualizer.range?.endIndex;
    if (
      requestingMore ||
      props.runsState !== "ready" ||
      props.runsLoadingMore ||
      !props.runsHasMore ||
      end === undefined ||
      end < props.rows.length - 6
    ) {
      return;
    }
    requestingMore = true;
    void Promise.resolve(props.onLoadMoreRuns()).finally(() => {
      requestingMore = false;
    });
  };
  const publish = () => {
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: () => (props.phoneLayout ? 160 : 80),
    observeElementRect,
    observeElementOffset: (instance, notify) => {
      synchronizeScrollOffset = () =>
        notify(instance.scrollElement?.scrollTop ?? 0, instance.isScrolling);
      return observeElementOffset(instance, notify);
    },
    scrollToFn: elementScroll,
    overscan: 3,
    // History pages extend the tail. Keep the reading position and measure
    // newly visible summaries before paint instead of following their growth.
    onChange: publish,
  });
  const pinFocus = () => {
    const index = current.findIndex((entry) => runKey(entry) === focusedKey);
    const pinned = [0, current.length - 1, index - 1, index, index + 1].filter(
      (item) => item >= 0 && item < current.length,
    );
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
    () => ({ rows: props.rows, getItemKey: getItemKey(), phoneLayout: props.phoneLayout }),
    (next) => {
      if (!next) {
        return;
      }
      scroller = list.closest<HTMLElement>(".content");
      if (next.rows !== current) {
        synchronizeScrollOffset?.();
      }
      current = next.rows;
      const margin = scroller
        ? list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : 0;
      virtualizer.setOptions({
        ...virtualizer.options,
        enabled: Boolean(scroller),
        count: next.rows.length,
        getItemKey: next.getItemKey,
        scrollMargin: margin,
      });
      pinFocus();
      if (virtualizer.scrollElement !== scroller) {
        const { _willUpdate: update } = virtualizer;
        update();
      }
      for (const element of elements) {
        virtualizer.measureElement(element);
      }
      publish();
    },
    { targets: () => [list, ...(scroller ? [scroller] : [])], changeTiming: "sync", fonts: true },
  );
  createLayoutMeasurement(
    () => ({
      window: window(),
      state: props.runsState,
      loadingMore: props.runsLoadingMore,
      hasMore: props.runsHasMore,
    }),
    (next) => {
      // Update the observer only after the new list height is committed.
      if (next && next.window !== committedWindow) {
        committedWindow = next.window;
        const { _willUpdate: update } = virtualizer;
        update();
      }
      loadNearEnd();
    },
    { targets: () => [list], changeTiming: "sync" },
  );
  const byKey = createMemo(
    () => new Map(props.rows.map((entry, index) => [runKey(entry), { entry, index }])),
  );
  const jobs = createMemo(() => new Map(props.jobs?.map((job) => [job.id, job]) ?? []));
  const geometry = createMemo(() => new Map(window().items.map((item) => [item.key, item])));
  const visible = createMemo(() =>
    !windowed()
      ? props.rows
      : !window().items.length
        ? props.rows.slice(0, 12)
        : window().items.flatMap((item) => byKey().get(String(item.key))?.entry ?? []),
  );
  function Row(row: { entry: CronRunLogEntry }) {
    let element!: HTMLDivElement;
    const registerElement = (node: HTMLDivElement) => {
      // Crossing the phone breakpoint replaces the row markup, not its run key.
      elements.delete(element);
      element = node;
      elements.add(node);
    };
    const key = () => runKey(row.entry);
    const item = () => geometry().get(key());
    const agentId = () => {
      const sessionAgent = parseAgentSessionKey(row.entry.sessionKey)?.agentId;
      const job = jobs().get(row.entry.jobId);
      // A known job without an explicit agent uses the configured default.
      // Deleted jobs without session metadata cannot identify an agent.
      return sessionAgent ?? (job ? job.agentId : null);
    };
    onSettled(() => {
      elements.add(element);
      virtualizer.measureElement(element);
      // Native scrolling defers measureElement to ResizeObserver. Measure a
      // newly mounted row before admitting a page against estimated geometry.
      if (virtualizer.isScrolling) {
        virtualizer.resizeItem(
          byKey().get(key())!.index,
          virtualizer.options.measureElement(element, undefined, virtualizer),
        );
      }
      return () => {
        elements.delete(element);
        virtualizer.measureElement(null);
      };
    });
    const style = () =>
      windowed()
        ? {
            position: "absolute" as const,
            width: "100%",
            top: `${(item()?.start ?? 0) - virtualizer.options.scrollMargin}px`,
          }
        : undefined;
    const onFocus = () => {
      if (focusedKey === key()) {
        return;
      }
      focusedKey = key();
      synchronizeScrollOffset?.();
      pinFocus();
      publish();
      if (windowed()) {
        virtualizer.scrollToIndex(byKey().get(key())!.index);
      }
    };
    return (
      <>
        {props.overview && !props.phoneLayout ? (
          <CompactRun
            entry={row.entry}
            agentId={agentId()}
            formatTimestamp={props.formatTimestamp}
            highlightedRunId={props.highlightedRunId}
            onRunMount={props.onRunMount}
            onViewRunTranscript={props.onViewRunTranscript}
            rowRef={registerElement}
            index={byKey().get(key())!.index}
            style={style()}
            onFocus={onFocus}
          />
        ) : (
          <LegacyRun
            entry={row.entry}
            formatTimestamp={props.formatTimestamp}
            highlightedRunId={props.highlightedRunId}
            onRunMount={props.onRunMount}
            onViewRunTranscript={props.onViewRunTranscript}
            rowRef={registerElement}
            index={byKey().get(key())!.index}
            style={style()}
            onFocus={onFocus}
          />
        )}
      </>
    );
  }
  return (
    <div
      ref={(node) => (list = node)}
      class="cron-runs__list"
      style={
        windowed()
          ? { position: "relative", height: `${window().height || props.rows.length * 80}px` }
          : undefined
      }
    >
      <For each={visible()} keyed={runKey}>
        {(entry) => <Row entry={entry()} />}
      </For>
    </div>
  );
}
