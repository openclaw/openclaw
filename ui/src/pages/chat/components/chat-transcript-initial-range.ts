import type { Range, Virtualizer } from "@tanstack/virtual-core";
import type { MarkdownPrewarmMode } from "../../../components/markdown.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { createTranscriptEndSettlement } from "./chat-transcript-end-anchor.ts";
import * as forecast from "./chat-transcript-forecast.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

// A few viewports avoid repeat mounts without making every scroll restyle a
// large parked subtree. Geometry and prepared Markdown outlive DOM eviction.
const PREPARED_ROW_LIMIT = 12;
const SCROLL_PREPARE_ROW_LIMIT = 8;
// Use idle time before a fast sweep reaches distant rows. The shared HTML cache
// still bounds admission; DOM and pristine-fragment limits stay unchanged.
const IDLE_PREWARM_ROW_LIMIT = 2048;
// Cover the first gesture without parsing the entire untouched transcript on open.
const INITIAL_PREWARM_ROW_LIMIT = 128;

/** Own initial tail placement and bounded preparation ahead of the visible range. */
export class TranscriptInitialRange {
  pending = true;
  preparingEnd = false;
  private endWork?: () => (() => void) | void;
  private readonly queueEndWork = () =>
    this.endWork && scheduleLayout(this, () => this.endWork?.());
  private tailRows: number;
  private rows: readonly TranscriptRow[] = [];
  private hasIdleDomRows = false;
  private hasRetainedRows = false;
  private hasPrewarmRows = false;
  // Completed text rows have no widget custody. Retain their keyed DOM while
  // keeping inactive rows outside the visible range's flow.
  readonly preparedRowKeys = new Set<string>();
  private preparingRowKey: string | undefined;
  readonly rowIndexes = new Map<string, number>();
  private cancelPreparation?: () => void;
  private preparationIsIdle = false;
  private idleStep = 1;
  private idleMeasureStep = 1;
  private scrollSample = { time: 0, distance: 0, direction: -1 };
  private pendingWheel?: { delta: number; time: number };
  private viewportOnly = false;
  private cachedWindow = false;
  private forecastTimeout?: ReturnType<typeof setTimeout>;

  get reading(): boolean {
    return !this.pending && !this.viewportOnly;
  }

  // Medium histories pair messages in each retained row; keep the same content budget.
  private get preparedRowLimit(): number {
    return this.hasRetainedRows && !this.hasIdleDomRows ? 6 : PREPARED_ROW_LIMIT;
  }

  private get scrollPrepareRowLimit(): number {
    return this.hasRetainedRows && !this.hasIdleDomRows ? 4 : SCROLL_PREPARE_ROW_LIMIT;
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
    private readonly rowsMeasured: (indexes: readonly number[]) => boolean,
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
      const preparingIndex = this.preparingRowKey
        ? this.rowIndexes.get(this.preparingRowKey)
        : undefined;
      if (preparingIndex !== undefined) {
        indexes.add(preparingIndex);
      }
      for (const index of this.endIndexes()) {
        indexes.add(index);
      }
      const limit =
        this.isReaderMoving() || this.pendingWheelDelta() !== 0
          ? Math.max(this.preparedRowLimit, indexes.size + this.scrollPrepareRowLimit)
          : Infinity;
      for (const index of forecast.indexes(
        this.virtualizer(),
        this.forecastViewport(),
        range,
        indexes,
        this.rows,
        this.scrollPrepareRowLimit,
      )) {
        indexes.add(index);
        // Keep the forecast alive until arrival instead of remounting it a frame later.
        const key = this.rows[index]!.key;
        this.preparedRowKeys.delete(key);
        this.preparedRowKeys.add(key);
      }
      // Keep the active and paced preparation windows; spend remaining slots on recent history.
      for (const key of this.retentionKeys(range)) {
        const index = this.rowIndexes.get(key);
        if (index !== undefined && (indexes.has(index) || indexes.size < limit)) {
          indexes.add(index);
        } else {
          this.preparedRowKeys.delete(key);
        }
      }
      return [...indexes].toSorted((left, right) => left - right);
    }
    const count = Math.min(range.count, this.tailRows);
    return Array.from({ length: count }, (_, index) => range.count - count + index);
  }

  presentation(rows: readonly TranscriptRow[]) {
    if (this.rows !== rows) {
      this.rows = rows;
      this.hasIdleDomRows = false;
      this.hasRetainedRows = false;
      this.hasPrewarmRows = false;
      for (const row of rows) {
        this.hasPrewarmRows ||= Boolean(row.prewarm || row.retainDom);
        this.hasRetainedRows ||= Boolean(row.retainDom);
        if (row.retainDom && !row.prewarm) {
          this.hasIdleDomRows = true;
          break;
        }
      }
    }
    this.retainViewportRows();
    const active = this.activeIndexes();
    const virtualizer = this.virtualizer();
    const first = active[0];
    // Ordinary rows would pay another commit on every wheel step. Retained fragments
    // need preparation before their cold, estimated height can enter the flow.
    const predecessor =
      !this.pending &&
      !this.preparingEnd &&
      first !== undefined &&
      rows[first]?.retainDom &&
      first === (virtualizer.range?.startIndex ?? 0) - 1 &&
      !this.cachedRowSize(first) &&
      !virtualizer.itemSizeCache.has(virtualizer.options.getItemKey(first)) &&
      !this.rowsMeasured([first])
        ? active.shift()
        : undefined;
    if (predecessor !== undefined && this.preparingRowKey !== rows[predecessor]!.key) {
      // Incoming overscan takes priority over speculative background preparation.
      this.preparingRowKey = rows[predecessor]!.key;
      // A resumed reader can have a cached moving range without this predecessor.
      this.refresh();
    }
    return {
      activeRowKeys: new Set([...active, ...this.endIndexes()].map((index) => rows[index]!.key)),
      preparingRowKey: this.preparingRowKey,
      forecastRowKeys: forecast.rowKeys(
        virtualizer,
        this.forecastViewport(),
        rows,
        this.preparedRowKeys,
      ),
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

  private pendingWheelDelta(): number {
    // Native scrollTop rounds fractional wheel travel. Its subpixel residue
    // must not replace the next observed step with a stationary forecast.
    const wheel = this.pendingWheel;
    const now = performance.now();
    return wheel && now - wheel.time < 100 && Math.abs(wheel.delta) > 1 ? wheel.delta : 0;
  }

  private forecastViewport() {
    if (this.viewportOnly || this.preparingEnd || !this.hasRetainedRows) {
      return undefined;
    }
    const pendingDelta = this.pendingWheelDelta();
    if (!pendingDelta && !this.isReaderMoving()) {
      return undefined;
    }
    return forecast.viewport(
      this.virtualizer(),
      pendingDelta || this.scrollSample.direction * this.scrollSample.distance,
      Boolean(this.pendingWheel && performance.now() - this.pendingWheel.time < 100),
    );
  }

  private normalIndexes(range: Range): number[] {
    if (this.viewportOnly) {
      return this.normalRange({ ...range, overscan: 0 }, this.rowIndexes);
    }
    if (
      this.isReaderMoving() &&
      this.scrollSample.distance >= (this.virtualizer().scrollRect?.height ?? 600)
    ) {
      // The first row starts at its cached offset. Shorter arriving rows leave
      // space after the window, so retain following overscan without mounting
      // the already-skipped preceding neighbour during a large jump.
      return this.normalRange(
        {
          ...range,
          endIndex: Math.min(range.count - 1, range.endIndex + range.overscan),
          overscan: 0,
        },
        this.rowIndexes,
      );
    }
    return this.normalRange(range, this.rowIndexes);
  }

  private endIndexes(): number[] {
    if (!this.preparingEnd) {
      return [];
    }
    const virtualizer = this.virtualizer();
    const height = virtualizer.scrollRect?.height ?? 0;
    if (height <= 0 || !this.rows.length) {
      return [];
    }
    const end =
      virtualizer.getTotalSize() +
      virtualizer.options.scrollMargin -
      virtualizer.options.paddingEnd;
    const first = virtualizer.getVirtualItemForOffset(end - height);
    if (!first) {
      return [];
    }
    return this.normalIndexes({
      startIndex: first.index,
      endIndex: this.rows.length - 1,
      count: this.rows.length,
      overscan: virtualizer.options.overscan,
      lanes: virtualizer.options.lanes,
    });
  }

  readonly prepareEnd = (ready: () => void, isCurrent: () => boolean, native: boolean): void => {
    this.pendingWheel = undefined;
    if (native && this.pending) {
      ready();
      return;
    }
    cancelLayout(this);
    this.preparingEnd = true;
    this.refresh();
    this.invalidate();
    const begin = () => {
      if (!this.preparingEnd || !this.canPrepare() || !isCurrent()) {
        return;
      }
      // Native sizes can expand the destination window without moving the current range.
      if (native) {
        this.refresh();
      }
      if (native ? !this.rowsMeasured(this.endIndexes()) : this.measureRows()) {
        this.invalidate();
        // A measurement can mount another row. Let the browser present before
        // its next pass instead of draining every correction in one task.
        this.afterCommit(this.queueEndWork);
        return;
      }
      this.endWork = undefined;
      ready();
    };
    this.endWork = () => begin;
    this.afterCommit(begin);
  };

  // Keep the destination in flow until its real size and native endpoint agree.
  readonly finishEndWhenSettled = (): void => {
    this.pendingWheel = undefined;
    if (!this.preparingEnd) {
      this.preparingEnd = true;
      this.refresh();
      this.invalidate();
    }
    const endWork = createTranscriptEndSettlement(
      this.virtualizer(),
      () => this.canPrepare() && this.endWork === endWork,
      this.rowsMeasured,
      this.queueEndWork,
      () => this.finishEnd(),
    );
    this.endWork = endWork;
    this.queueEndWork();
  };

  finishEnd(): void {
    this.endWork = undefined;
    cancelLayout(this);
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
    this.pendingWheel = undefined;
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
    }
  }

  private isReaderMoving(): boolean {
    // Size compensation also sets isScrolling; only reader input interrupts idle preparation.
    return this.scrollSample.time > 0 && performance.now() - this.scrollSample.time < 100;
  }

  didCommit(): void {
    // Revealing a parked pane resumes its current end stage without hidden polling.
    if (this.endWork && this.canPrepare()) {
      this.queueEndWork();
    }
    if (this.preparationIsIdle && this.isReaderMoving()) {
      this.cancelPreparation?.();
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
    }
    this.queuePreparation();
  }

  recordReaderMovement(delta: number): void {
    const pendingDelta = this.pendingWheelDelta();
    if (this.pendingWheel) {
      this.pendingWheel.delta =
        Math.sign(delta) === Math.sign(pendingDelta)
          ? Math.sign(pendingDelta) * Math.max(0, Math.abs(pendingDelta) - Math.abs(delta))
          : 0;
    }
    this.idleStep = 1;
    this.idleMeasureStep = 1;
    this.scrollSample = {
      time: performance.now(),
      distance: Math.abs(delta),
      direction: Math.sign(delta),
    };
    this.finishEnd();
    this.finish();
    if (!this.hasRetainedRows || this.preparingEnd) {
      return;
    }
    this.refresh();
    this.scheduleForecastExpiry();
  }

  recordWheel(delta: number): void {
    if (!this.reading || this.preparingEnd || !this.hasRetainedRows || !this.canPrepare()) {
      return;
    }
    this.pendingWheel = {
      delta: this.pendingWheelDelta() + delta,
      time: performance.now(),
    };
    this.cancelPreparation?.();
    this.cancelPreparation = undefined;
    this.preparationIsIdle = false;
    this.refresh();
    this.invalidate();
    this.scheduleForecastExpiry();
  }

  private scheduleForecastExpiry(): void {
    clearTimeout(this.forecastTimeout);
    this.forecastTimeout = setTimeout(() => {
      this.forecastTimeout = undefined;
      this.pendingWheel = undefined;
      this.refresh();
      this.invalidate();
    }, 100);
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
    // During a fling, keep approaching rows before the viewport we just
    // left. Geometry survives eviction in virtual-core's size cache.
    for (const key of this.retentionKeys(range).slice(this.preparedRowLimit)) {
      this.preparedRowKeys.delete(key);
    }
  }

  private retentionKeys(range: { startIndex: number; endIndex: number }): string[] {
    return forecast.retainedKeys(
      this.preparedRowKeys,
      this.rowIndexes,
      this.rows.length,
      range,
      this.pendingWheelDelta() || (this.isReaderMoving() ? this.scrollSample.direction : 0),
    );
  }

  private queuePreparation(afterFrame = false): void {
    if (
      this.cancelPreparation ||
      this.pendingWheelDelta() !== 0 ||
      !this.hasPrewarmRows ||
      (!this.hasRetainedRows && this.rows.at(-1)?.streaming) ||
      this.preparingEnd ||
      this.pending ||
      !this.canPrepare()
    ) {
      return;
    }
    const idlePrewarmLimit =
      this.scrollSample.time && this.hasIdleDomRows
        ? IDLE_PREWARM_ROW_LIMIT
        : INITIAL_PREWARM_ROW_LIMIT;
    const idleRange = this.virtualizer().range;
    if (
      idleRange &&
      (this.viewportOnly || !this.hasIdleDomRows || this.idleMeasureStep > PREPARED_ROW_LIMIT) &&
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
    const queueNext = () => this.queuePreparation(true);
    const prepare = (deadline: number, prewarmRequested = false, warmOnly = false) => {
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
      if (performance.now() >= deadline) {
        queueNext();
        return;
      }
      const virtualizer = this.virtualizer();
      const range = virtualizer.range;
      if (
        this.preparingEnd ||
        !this.hasPrewarmRows ||
        (!this.hasRetainedRows && this.rows.at(-1)?.streaming) ||
        !this.canPrepare() ||
        !range ||
        !virtualizer.scrollElement ||
        (this.preparingRowKey && !warmOnly)
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
      // Large steps need the arriving viewport, including its interior rows.
      // Retained rows already forecast their DOM; this queue warms ordinary Markdown.
      const prewarm = prewarmRequested || (moving && this.scrollSample.distance >= viewport);
      // HTML warming is synchronous: predict one observed scroll step and walk
      // into that viewport, rather than beyond its leading edge.
      const distance = moving ? this.scrollSample.distance : 0;
      const { predictedTop, predicted, overscan, origin } = forecast.preparation(
        virtualizer,
        range,
        direction,
        distance,
      );
      const rendered = new Set(virtualizer.getVirtualItems().map((row) => row.key));
      // Before reader navigation, keep warming out of the native scroll geometry.
      const nearGeometryPending =
        this.hasIdleDomRows && !this.viewportOnly && this.idleMeasureStep <= PREPARED_ROW_LIMIT;
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
          const index = origin + this.idleStep * direction;
          const row = rows[index];
          if (!row) {
            break;
          }
          // Ordinary rows warm data only; retaining their trees doubled mixed-session DOM.
          const mode =
            row.retainDom && !row.prewarm && this.idleStep <= PREPARED_ROW_LIMIT
              ? "fragment"
              : "idle-html";
          if (!rendered.has(row.key) && (row.prewarm || row.retainDom) && this.prewarmRow) {
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
      const opposite = distance
        ? virtualizer.getVirtualItemForOffset(predictedTop + (direction > 0 ? viewport : 0))
        : undefined;
      const lookahead =
        opposite && predicted
          ? Math.abs(opposite.index - predicted.index) + 1 + 2 * overscan
          : this.scrollPrepareRowLimit;
      let admitted = 0;
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
          queueNext();
          return;
        }
        const index = origin + step * direction;
        const row = rows[index];
        if (!row) {
          break;
        }
        if (!moving && !warmOnly) {
          this.idleMeasureStep = step + 1;
        }
        const canPrepareRow =
          !moving && row.retainDom && !rendered.has(row.key) && !this.preparedRowKeys.has(row.key);
        // Idle admission skips retained DOM and live/widget rows to keep
        // measuring beyond a cached prefix after the reader changes direction.
        if (moving || warmOnly || canPrepareRow) {
          candidates++;
        }
        if (
          prewarm &&
          moving &&
          row.prewarm &&
          !row.retainDom &&
          !rendered.has(row.key) &&
          this.prewarmRow
        ) {
          // Warm one message at a time; an unloaded module or spent slice yields.
          let warming: boolean | undefined;
          while ((warming = this.prewarmRow(index, "html")) !== false) {
            if (warming === undefined || !warmOnly || performance.now() >= deadline) {
              queueNext();
              return;
            }
          }
        }
        if (canPrepareRow && !this.preparingRowKey) {
          // Keep nearby DOM hot; farther idle rows live only until their
          // measurement enters the virtualizer's geometry cache.
          if (this.preparedRowKeys.size < PREPARED_ROW_LIMIT) {
            this.preparedRowKeys.add(row.key);
          }
          this.preparingRowKey = row.key;
          admitted++;
        }
      }
      if (admitted) {
        this.refresh();
        this.invalidate();
        // Markdown can keep warming while the single admitted DOM row is measured.
        queueNext();
      } else if (prewarm && !moving && this.idleMeasureStep > PREPARED_ROW_LIMIT) {
        // Ordinary rows need no DOM admission; resume their remaining HTML sweep.
        queueNext();
      }
    };
    if (this.isReaderMoving() && this.prewarmRow && typeof requestIdleCallback === "function") {
      const queueTask = () => {
        // Rendering can delay this timer beyond six milliseconds. Budget its
        // own work so a busy frame cannot starve the next viewport's preparation.
        const task = setTimeout(() => prepare(performance.now() + 6, true, true), 0);
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
    this.pendingWheel = undefined;
    this.rows = [];
    this.hasIdleDomRows = false;
    this.hasRetainedRows = false;
    this.hasPrewarmRows = false;
  }

  disconnect(): void {
    clearTimeout(this.forecastTimeout);
    this.pendingWheel = undefined;
    this.endWork = undefined;
    cancelLayout(this);
    this.cancelPreparation?.();
    this.cancelPreparation = undefined;
    this.preparationIsIdle = false;
    this.preparingRowKey = undefined;
    this.preparedRowKeys.clear();
    this.viewportOnly = false;
    this.preparingEnd = false;
    this.refresh();
  }
}
