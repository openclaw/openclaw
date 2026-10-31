import type { Range, Virtualizer } from "@tanstack/virtual-core";
import type { MarkdownPrewarmMode } from "../../../components/markdown.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

// A few viewports avoid repeat mounts without making every scroll restyle a
// large parked subtree. Geometry and prepared Markdown outlive DOM eviction.
const PREPARED_ROW_LIMIT = 12;
// Use idle time before a fast sweep reaches distant rows. The shared HTML cache
// still bounds admission; DOM and pristine-fragment limits stay unchanged.
const IDLE_PREWARM_ROW_LIMIT = 2048;
// Cover the first gesture without parsing the entire untouched transcript on open.
const INITIAL_PREWARM_ROW_LIMIT = 128;
// A fast first gesture can skip dozens of rows before velocity is known.
// Keep nearby sanitized DOM ready without mounting it or changing geometry.
const IDLE_FRAGMENT_ROW_LIMIT = 128;

/** Own initial tail placement and bounded preparation ahead of the visible range. */
export class TranscriptInitialRange {
  pending = true;
  preparingEnd = false;
  private tailRows: number;
  private rows: readonly TranscriptRow[] = [];
  private hasRetainedRows = false;
  // Completed text rows have no widget custody. Retain their keyed DOM while
  // keeping inactive rows outside the visible range's flow.
  readonly preparedRowKeys = new Set<string>();
  private preparingRowKey: string | undefined;
  readonly rowIndexes = new Map<string, number>();
  private cancelPreparation?: () => void;
  private preparationIsIdle = false;
  private prepareStarted = 0;
  private prepareLatency = 16;
  private idleStep = 1;
  private idleMeasureStep = 1;
  private scrollSample = { time: 0, distance: 0, velocity: 0, direction: -1 };
  private viewportOnly = false;
  private cachedWindow = false;

  get reading(): boolean {
    return !this.pending && !this.viewportOnly;
  }

  constructor(
    initialOffset: number | null,
    private readonly virtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly normalRange: (range: Range, indexes: ReadonlyMap<string, number>) => number[],
    private readonly invalidate: () => void,
    private readonly cachedRowSize: (index: number) => number,
    private readonly canPrepare: () => boolean,
    private readonly measure: (
      element: HTMLElement,
      entry: ResizeObserverEntry | undefined,
    ) => number,
    private readonly afterCommit: (effect: () => void) => void,
    private readonly measureRows: () => boolean,
    private readonly prewarmRow?: (index: number, mode: MarkdownPrewarmMode) => boolean | undefined,
    private readonly invalidatePreparation: () => void = invalidate,
  ) {
    this.tailRows = initialOffset === null ? 1 : 0;
  }

  extract(range: Range): number[] {
    const height = this.pending ? this.viewportRowHeight(this.virtualizer().scrollElement) : 0;
    if (height > 0) {
      let startIndex = range.startIndex;
      if (this.tailRows) {
        const virtualizer = this.virtualizer();
        startIndex = range.count - 1;
        let covered = this.cachedRowSize(startIndex);
        while (startIndex > 0 && covered > 0 && covered < height) {
          const size = this.cachedRowSize(--startIndex);
          if (!size) {
            break;
          }
          covered += size + virtualizer.options.gap;
        }
      }
      const cachedRange = {
        ...range,
        startIndex,
        endIndex: this.tailRows ? range.count - 1 : range.endIndex,
      };
      let indexes = this.normalRange(cachedRange, this.rowIndexes);
      const cachedWindow = indexes.every((index) => this.cachedRowSize(index) > 0);
      if (!cachedWindow && this.tailRows) {
        indexes = this.normalRange({ ...cachedRange, overscan: 0 }, this.rowIndexes);
      }
      if (indexes.length && indexes.every((index) => this.cachedRowSize(index) > 0)) {
        // Exact-width footprints cover the viewport and overscan; no measurement ladder is needed.
        if (this.tailRows) {
          this.tailRows = range.count - indexes[0]!;
        }
        this.cachedWindow = cachedWindow;
        return indexes;
      }
    }
    if (!this.tailRows) {
      const indexes = new Set(this.normalIndexes(range));
      for (const key of this.preparedRowKeys) {
        const index = this.rowIndexes.get(key);
        if (index !== undefined) {
          indexes.add(index);
        }
      }
      const preparingIndex = this.preparingRowKey
        ? this.rowIndexes.get(this.preparingRowKey)
        : undefined;
      if (preparingIndex !== undefined) {
        indexes.add(preparingIndex);
      }
      for (const index of this.endIndexes()) {
        indexes.add(index);
      }
      return [...indexes].toSorted((left, right) => left - right);
    }
    const count = Math.min(range.count, this.tailRows);
    return Array.from({ length: count }, (_, index) => range.count - count + index);
  }

  presentation(rows: readonly TranscriptRow[]) {
    if (this.rows !== rows) {
      this.rows = rows;
      this.hasRetainedRows = rows.some((row) => row.retainDom);
    }
    this.retainViewportRows();
    return {
      activeRowKeys: new Set(
        [...this.activeIndexes(), ...this.endIndexes()].map((index) => rows[index]!.key),
      ),
      preparingRowKey: this.preparingRowKey,
    };
  }

  private activeIndexes(): number[] {
    const virtualizer = this.virtualizer();
    if (this.tailRows) {
      return virtualizer.getVirtualItems().map((row) => row.index);
    }
    const range = virtualizer.calculateRange();
    return range
      ? this.normalIndexes({
          ...range,
          count: virtualizer.options.count,
          overscan: virtualizer.options.overscan,
        })
      : [];
  }

  private normalIndexes(range: Range): number[] {
    // Large jumps skip these neighbours on the next frame. Spend their mount
    // budget preparing the arriving viewport instead.
    const jumping =
      this.isReaderMoving() &&
      this.scrollSample.distance >= (this.virtualizer().scrollRect?.height ?? 600);
    return this.normalRange(
      this.viewportOnly || jumping ? { ...range, overscan: 0 } : range,
      this.rowIndexes,
    );
  }

  private endIndexes(): number[] {
    if (!this.preparingEnd) {
      return [];
    }
    const virtualizer = this.virtualizer();
    const height = virtualizer.scrollRect?.height ?? 0;
    const indexes: number[] = [];
    let covered = 0;
    for (let index = this.rows.length - 1; index >= 0 && covered < height; index--) {
      indexes.push(index);
      covered +=
        (virtualizer.itemSizeCache.get(this.rows[index]!.key) ??
          virtualizer.options.estimateSize(index)) + virtualizer.options.gap;
    }
    return indexes;
  }

  readonly prepareEnd = (ready: () => void, isCurrent: () => boolean): void => {
    this.preparingEnd = true;
    this.refresh();
    this.invalidate();
    const begin = () => {
      if (!this.canPrepare() || !isCurrent()) {
        return;
      }
      if (this.measureRows()) {
        this.invalidate();
        this.afterCommit(begin);
        return;
      }
      this.finishEnd();
      ready();
    };
    this.afterCommit(begin);
  };

  finishEnd(): void {
    if (this.preparingEnd) {
      this.preparingEnd = false;
      this.refresh();
      this.invalidate();
    }
  }

  private viewportRowHeight(element: HTMLDivElement | null): number {
    // Bottom padding fills the same part of the viewport for cached and measured rows.
    return element
      ? element.clientHeight - (Number.parseFloat(getComputedStyle(element).paddingBottom) || 0)
      : 0;
  }

  private refresh(): void {
    const virtualizer = this.virtualizer();
    virtualizer.setOptions({
      ...virtualizer.options,
      // Range extraction is memoized by function identity, independently of row measurements.
      rangeExtractor: (range) => this.extract(range),
    });
  }

  extend(element: HTMLDivElement): boolean {
    const virtualizer = this.virtualizer();
    if (
      !(
        this.tailRows > 0 &&
        this.tailRows < virtualizer.options.count &&
        virtualizer.getVirtualItems().reduce((height, row) => height + row.size, 0) <
          this.viewportRowHeight(element)
      )
    ) {
      return false;
    }
    // One preceding row avoids preparing and discarding expensive Markdown on estimates.
    this.tailRows += 1;
    this.refresh();
    return true;
  }

  finish(viewportOnly = false): void {
    const changed = this.viewportOnly !== viewportOnly;
    this.pending = false;
    // Boot placement can precede the native extent; only reader navigation
    // releases its anchor to subsequent native-offset measurements.
    this.viewportOnly = viewportOnly;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = undefined;
    if (!this.tailRows && !changed) {
      return;
    }
    // The measured viewport stays adaptive; offscreen rows wait for reader navigation.
    this.tailRows = 0;
    this.refresh();
    this.invalidate();
  }

  complete(): void {
    if (this.pending) {
      this.finish(!this.cachedWindow);
    }
  }

  updateRows(rows: readonly TranscriptRow[]): void {
    this.idleStep = 1;
    this.idleMeasureStep = 1;
    const indexes = this.rowIndexes;
    indexes.clear();
    rows.forEach((row, index) => indexes.set(row.key, index));
    for (const key of this.preparedRowKeys) {
      const index = indexes.get(key);
      if (index === undefined || !rows[index]?.retainDom) {
        this.preparedRowKeys.delete(key);
      }
    }
    if (this.preparingRowKey && !rows[indexes.get(this.preparingRowKey) ?? -1]?.retainDom) {
      this.preparingRowKey = undefined;
      this.prepareStarted = 0;
    }
  }

  private isReaderMoving(): boolean {
    // Size compensation also sets isScrolling; only reader input interrupts idle preparation.
    return this.scrollSample.time > 0 && performance.now() - this.scrollSample.time < 100;
  }

  didCommit(): void {
    if (this.preparationIsIdle && this.isReaderMoving()) {
      this.cancelPreparation?.();
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
    }
    this.queuePreparation();
  }

  recordReaderMovement(delta: number): void {
    this.idleStep = 1;
    this.idleMeasureStep = 1;
    const now = performance.now();
    const previous = this.scrollSample;
    this.scrollSample = {
      time: now,
      distance: Math.abs(delta),
      velocity: previous.time ? Math.abs(delta) / Math.max(16, now - previous.time) : 0,
      direction: Math.sign(delta),
    };
    this.finish();
  }

  readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
  ): number => {
    const size = this.measure(element, entry);
    const key = element.dataset.virtualRowKey;
    if (
      key !== undefined &&
      key === this.preparingRowKey &&
      (entry || !this.virtualizer().targetWindow?.ResizeObserver)
    ) {
      // This is readiness latency, including layout, rather than CPU time.
      this.prepareLatency = Math.max(1, performance.now() - this.prepareStarted);
      this.prepareStarted = 0;
      queueMicrotask(() => {
        if (this.preparingRowKey === key) {
          this.preparingRowKey = undefined;
          if (!this.preparedRowKeys.has(key)) {
            this.refresh();
          }
          this.invalidatePreparation();
          this.queuePreparation();
        }
      });
    }
    return size;
  };

  private retainViewportRows(): void {
    const virtualizer = this.virtualizer();
    const range = virtualizer.range;
    if (!range || this.pending || this.viewportOnly) {
      return;
    }
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const row = this.rows[index];
      if (row?.retainDom) {
        this.preparedRowKeys.delete(row.key);
        this.preparedRowKeys.add(row.key);
      }
    }
    // The recent viewport wins over speculative preparation; geometry stays in
    // virtual-core's size cache even after the bounded DOM cache evicts a row.
    while (this.preparedRowKeys.size > PREPARED_ROW_LIMIT) {
      this.preparedRowKeys.delete(this.preparedRowKeys.keys().next().value!);
    }
  }

  private queuePreparation(materialize = false, afterFrame = false): void {
    if (
      this.cancelPreparation ||
      !this.hasRetainedRows ||
      this.preparingEnd ||
      this.pending ||
      this.tailRows > 0 ||
      !this.canPrepare()
    ) {
      return;
    }
    const materializeRow = materialize && !this.preparingRowKey;
    const idlePrewarmLimit = this.scrollSample.time
      ? IDLE_PREWARM_ROW_LIMIT
      : INITIAL_PREWARM_ROW_LIMIT;
    const idleRange = this.virtualizer().range;
    if (
      idleRange &&
      (this.viewportOnly || this.idleMeasureStep > PREPARED_ROW_LIMIT) &&
      performance.now() - this.scrollSample.time >= 100
    ) {
      const sampledDirection = this.scrollSample.direction;
      const inward =
        (sampledDirection > 0 && idleRange.endIndex === this.rows.length - 1) ||
        (sampledDirection < 0 && idleRange.startIndex === 0);
      const direction = inward ? -sampledDirection : sampledDirection;
      const remaining =
        direction > 0 ? this.rows.length - 1 - idleRange.endIndex : idleRange.startIndex;
      // Commits must not re-arm callbacks after the permitted sweep.
      // Reader movement and structural changes reset the existing cursors.
      if (this.idleStep > Math.min(idlePrewarmLimit, remaining)) {
        return;
      }
    }
    const queueNext = (withDom = false) => this.queuePreparation(withDom, true);
    const prepare = (deadline: number, prewarmRequested = false, warmOnlyRequested = false) => {
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
      if (performance.now() >= deadline) {
        queueNext(!warmOnlyRequested);
        return;
      }
      const virtualizer = this.virtualizer();
      const range = virtualizer.range;
      if (
        this.preparingEnd ||
        !this.hasRetainedRows ||
        !this.canPrepare() ||
        !range ||
        !virtualizer.scrollElement ||
        (this.prepareStarted && !warmOnlyRequested)
      ) {
        return;
      }
      const rows = this.rows;
      const sampledDirection = this.scrollSample.direction;
      // Initial placement and size compensation can point beyond an edge.
      // Idle work there prepares inward, where the reader can actually go.
      const inward =
        (sampledDirection > 0 && range.endIndex === rows.length - 1) ||
        (sampledDirection < 0 && range.startIndex === 0);
      const direction = inward ? -sampledDirection : sampledDirection;
      const viewport = virtualizer.scrollRect?.height ?? 600;
      const moving = !inward && this.isReaderMoving();
      const velocity = moving ? this.scrollSample.velocity : 0;
      // Large steps need the arriving viewport, including its interior rows.
      // Warm its Markdown first, then admit one DOM row on a later budget.
      const viewportStep = moving && this.scrollSample.distance >= viewport;
      const prewarm = prewarmRequested || viewportStep;
      const warmOnly = warmOnlyRequested;
      const arrivingViewport = warmOnly || viewportStep;
      // HTML warming is synchronous: predict one observed scroll step and walk
      // into that viewport, rather than beyond its leading edge.
      const distance = moving
        ? arrivingViewport
          ? this.scrollSample.distance
          : velocity * (16 + this.prepareLatency)
        : 0;
      // At speed, prepare the next viewport rather than rows the reader skips.
      // Virtual-core resolves this from cached sizes; no neighbor layout reads.
      const predictedTop = Math.max(
        0,
        Math.min(
          (virtualizer.scrollOffset ?? 0) + direction * distance,
          Math.max(0, virtualizer.getTotalSize() - viewport),
        ),
      );
      const predictedOffset =
        predictedTop + ((arrivingViewport ? direction < 0 : direction > 0) ? viewport : 0);
      const predicted = virtualizer.getVirtualItemForOffset(Math.max(0, predictedOffset));
      // Prediction can reach an edge before the viewport. Prepare back into the
      // transcript instead of searching past an ordinary, nonfragment edge row.
      let searchDirection = direction;
      if (!arrivingViewport && distance && predicted) {
        if (predicted.index === 0) {
          searchDirection = 1;
        } else if (predicted.index === rows.length - 1) {
          searchDirection = -1;
        }
      }
      // Ordinary rows mount with overscan. Warm those neighbours as well as
      // the viewport so its first frame does not parse the cold edge rows.
      const overscan = arrivingViewport && distance ? virtualizer.options.overscan : 0;
      const origin =
        distance && predicted
          ? predicted.index - searchDirection * (1 + overscan)
          : direction > 0
            ? range.endIndex
            : range.startIndex;
      const rendered = new Set(virtualizer.getVirtualItems().map((row) => row.key));
      // Before reader navigation, keep warming out of the native scroll geometry.
      const nearGeometryPending = !this.viewportOnly && this.idleMeasureStep <= PREPARED_ROW_LIMIT;
      if (prewarm && !moving) {
        // Measure nearby prepared rows before spending idle slices on distant HTML.
        const warmLimit = nearGeometryPending ? PREPARED_ROW_LIMIT : idlePrewarmLimit;
        // Resume the sweep rather than charging every slice for its cached prefix.
        // A row can contain several messages; false means ready or not admitted
        // by the bounded cache, so even an oversized row eventually advances.
        while (this.idleStep <= warmLimit) {
          if (performance.now() >= deadline) {
            queueNext();
            return;
          }
          const index = origin + this.idleStep * searchDirection;
          const row = rows[index];
          if (!row) {
            break;
          }
          const mode = this.idleStep <= IDLE_FRAGMENT_ROW_LIMIT ? "fragment" : "idle-html";
          if (!rendered.has(row.key) && this.prewarmRow) {
            const warmed = this.prewarmRow(index, mode);
            if (warmed === undefined) {
              queueNext();
              return;
            }
            if (warmed) {
              continue;
            }
          }
          this.idleStep++;
        }
      }
      // Distant DOM measurements continuously change the native extent while
      // a reader rests. Keep nearby geometry ready and warm only HTML farther out.
      if (!moving && !nearGeometryPending) {
        return;
      }
      // Warming covers the predicted viewport, whose row count varies with
      // measured heights. A fixed candidate cap left its last rows cold.
      const opposite =
        arrivingViewport && distance
          ? virtualizer.getVirtualItemForOffset(predictedTop + (direction > 0 ? viewport : 0))
          : undefined;
      const domLookahead =
        velocity || warmOnly
          ? 8
          : Math.max(
              // A full visible window still measures one temporary row so idle
              // geometry can finish and hand off to distant Markdown warming.
              1,
              PREPARED_ROW_LIMIT -
                this.activeIndexes().filter((index) => rows[index]?.retainDom).length,
            );
      const lookahead =
        opposite && predicted
          ? Math.abs(opposite.index - predicted.index) + 1 + 2 * overscan
          : domLookahead;
      let admitted = 0;
      let warmed = false;
      let canMaterialize = false;
      let preparedCandidate: string | undefined;
      let candidates = 0;
      for (
        let step = moving || warmOnly ? 1 : this.idleMeasureStep;
        candidates < lookahead && admitted === 0;
        step++
      ) {
        if (!moving && step > PREPARED_ROW_LIMIT) {
          break;
        }
        if (performance.now() >= deadline) {
          queueNext(warmOnly ? canMaterialize : true);
          return;
        }
        const index = origin + step * searchDirection;
        const row = rows[index];
        if (!row) {
          break;
        }
        if (!moving && !warmOnly) {
          this.idleMeasureStep = step + 1;
        }
        const canPrepareRow =
          row.retainDom && !rendered.has(row.key) && !this.preparedRowKeys.has(row.key);
        // Idle admission skips retained DOM and live/widget rows to keep
        // measuring beyond a cached prefix after the reader changes direction.
        if (moving || warmOnly || canPrepareRow) {
          candidates++;
        }
        canMaterialize ||= Boolean(canPrepareRow);
        if (canPrepareRow) {
          preparedCandidate ??= row.key;
        }
        // Distant HTML must not evict the nearby fragments needed by the next scroll.
        const mode = arrivingViewport || step <= 8 ? "fragment" : "html";
        const warm = () =>
          prewarm && moving && !rendered.has(row.key) && this.prewarmRow
            ? this.prewarmRow(index, mode)
            : false;
        for (let warming = warm(); warming !== false; warming = warm()) {
          // An unloaded preparation module yields this slice without advancing the row.
          if (warming === undefined) {
            queueNext();
            return;
          }
          // The shared cache owns readiness; no DOM or range invalidation is needed.
          if (warmOnly) {
            warmed = true;
            // One admission prepares one message, not the whole atomic row.
            if (performance.now() >= deadline) {
              queueNext();
              return;
            }
            continue;
          }
          queueNext();
          return;
        }
        if (!warmOnly && candidates <= domLookahead && canPrepareRow) {
          if (performance.now() >= deadline) {
            queueNext();
            return;
          }
          // Keep nearby DOM hot; farther idle rows live only until their
          // measurement enters the virtualizer's geometry cache.
          if (moving || this.preparedRowKeys.size < PREPARED_ROW_LIMIT) {
            this.preparedRowKeys.add(row.key);
          }
          this.preparingRowKey = row.key;
          admitted++;
        }
      }
      if (warmOnly && preparedCandidate && !this.preparingRowKey && performance.now() < deadline) {
        // A fully warm viewport can use the rest of this slice to prepare one
        // DOM row, before the next scroll frame reaches it.
        this.preparedRowKeys.add(preparedCandidate);
        this.preparingRowKey = preparedCandidate;
        admitted++;
      }
      if (!admitted) {
        if (warmOnly && (warmed || canMaterialize)) {
          queueNext(canMaterialize);
        } else if (
          prewarm &&
          !moving &&
          nearGeometryPending &&
          this.idleMeasureStep > PREPARED_ROW_LIMIT
        ) {
          // Ordinary rows need no DOM admission; resume their remaining HTML sweep.
          queueNext();
        }
        return;
      }
      this.prepareStarted = performance.now();
      virtualizer.setOptions({
        ...virtualizer.options,
        rangeExtractor: (next) => this.extract(next),
      });
      this.invalidate();
      // Markdown can keep warming while the single admitted DOM row is measured.
      queueNext();
    };
    if (this.isReaderMoving() && this.prewarmRow && typeof requestIdleCallback === "function") {
      const queueTask = () => {
        // Rendering can delay this timer beyond six milliseconds. Budget its
        // own work so a busy frame cannot starve the next viewport's preparation.
        const task = setTimeout(
          () => prepare(performance.now() + 6, !materializeRow, !materializeRow),
          0,
        );
        this.cancelPreparation = () => clearTimeout(task);
      };
      // Start without waiting for another frame. Subsequent slices stay
      // frame-paced so preparation cannot form a timer loop.
      if (afterFrame) {
        const frame = requestAnimationFrame(queueTask);
        this.cancelPreparation = () => cancelAnimationFrame(frame);
      } else {
        queueTask();
      }
    } else if (typeof requestIdleCallback === "function") {
      this.preparationIsIdle = true;
      const idleRequest = requestIdleCallback(
        (idle) => prepare(performance.now() + (idle.timeRemaining() >= 6 ? 6 : 0), true),
        { timeout: 250 },
      );
      this.cancelPreparation = () => cancelIdleCallback(idleRequest);
    } else {
      // Admit one atomic fragment early in the frame, then await its measurement.
      // The fragment itself can overrun this six-millisecond admission budget.
      const frame = requestAnimationFrame((time) => prepare(time + 6));
      this.cancelPreparation = () => cancelAnimationFrame(frame);
    }
  }

  releaseRows(): void {
    this.rows = [];
    this.hasRetainedRows = false;
  }

  disconnect(): void {
    this.cancelPreparation?.();
    this.cancelPreparation = undefined;
    this.preparationIsIdle = false;
    this.prepareStarted = 0;
    this.preparingRowKey = undefined;
    this.preparedRowKeys.clear();
    this.viewportOnly = false;
    this.preparingEnd = false;
    this.refresh();
  }
}
