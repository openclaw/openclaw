import type { JSX } from "@solidjs/web";
// Per-session virtualizer host: scroll anchoring, measurement, and row sync
// for one transcript. Owned and swapped by the chat transcript owner.
import { Virtualizer } from "@tanstack/virtual-core";
import type { ApplicationContext } from "../../../app/context.ts";
import { createMcpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { resolveScrollBehavior } from "../../../lib/scroll-behavior.ts";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import type { ChatSessionScrollPosition, ChatScrollToEndOptions } from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { ChatMessageEntryAnimations } from "./chat-message-entry.ts";
import { ChatMessageReveal } from "./chat-message-reveal.ts";
import {
  TranscriptAnnouncementState,
  type TranscriptAnnouncement,
} from "./chat-transcript-announcement.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  initialTranscriptRect,
  isTranscriptRangeCommitted,
  createPositionRailGutter,
} from "./chat-transcript-geometry.ts";
import { reconcileTranscriptHeaderMargin } from "./chat-transcript-header.ts";
import { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";
import {
  reconcileChatTranscriptInteractionResize,
  resolveChatTranscriptInteractionAnchor,
} from "./chat-transcript-interaction-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptContent, TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import {
  isTranscriptMaintenanceScroll,
  isTranscriptProgrammaticScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
  scrollTranscriptToEnd,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { activeTranscriptMessageId } from "./chat-transcript-position.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  focusedTranscriptRowKey,
  leavingTranscriptMcpAppRows,
  previewTranscriptRowKeys,
} from "./chat-transcript-range.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import {
  applyPendingScrollOffset,
  type TranscriptScrollRestoreHost,
} from "./chat-transcript-scroll-restore.ts";
import {
  CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
  CHAT_TRANSCRIPT_OVERSCAN,
  createTranscriptPresentation,
  type ChatTranscriptSession,
  type TranscriptCallbacks,
  type TranscriptHeader,
  type TranscriptRenderSnapshot,
} from "./chat-transcript-session.ts";
import { TranscriptViewportRect } from "./chat-transcript-viewport-rect.ts";

export class ChatSessionVirtualizerHost implements ChatTranscriptSession {
  private readonly renderer = new ChatTranscriptRenderer();
  private readonly offsetState = new TranscriptOffsetState();
  readonly entryAnimations = new ChatMessageEntryAnimations();
  readonly messageElements = createTranscriptMessageElements(this.entryAnimations.refFor);
  expandedAssistantMessages = new Map<string, AssistantMessageExpansionState>();
  private readonly positionRail: ReturnType<typeof createPositionRailGutter>;
  private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  private readonly viewportRect: TranscriptViewportRect;
  private readonly presentation: ReturnType<typeof createTranscriptPresentation>;
  private cleanupVirtualizer?: () => void;
  private threadInnerElement: HTMLDivElement | null = null;
  connected = false;
  // The in-flow history header's fixed height, folded into scrollMargin.
  // appliedHeaderHeight is what the current virtualizer margin already carries.
  private headerHeight = 0;
  private appliedHeaderHeight = 0;
  private readonly initialRange: TranscriptInitialRange;
  private readonly endAnchor = new TranscriptEndAnchor((fn) => this.renderer.queueAfterCommit(fn));
  private readonly recordEndLayoutCorrection = (before: number, after: number) => {
    this.endAnchor.recordLayoutCorrection(before, after);
    this.scheduleEndReconcile();
  };
  readonly layout = new TranscriptLayoutOwner(this.recordEndLayoutCorrection);
  private readonly followEnd = () =>
    this.scrollToEnd({
      source: "auto",
      behavior: this.offsetState.scrollCommand?.behavior ?? "auto",
    });
  private readonly reconcileEnd = () => {
    if (this.connected && !this.offsetState.pendingInteractionAnchor) {
      this.commitComposerResize(true);
      // Initial layout owns positioning until the visible range is measured.
      if (!this.initialRange.pending) {
        this.endAnchor.reconcile(
          this.scrollElement,
          this.canAutoFollow(),
          this.offsetState.pendingScrollOffset !== null || this.offsetState.touchActive,
          this.followEnd,
        );
      }
    }
  };
  private readonly scrollRestoreHost: TranscriptScrollRestoreHost;
  private readonly messageReveal = new ChatMessageReveal(this.messageElements.elements);
  // The caller can insert this root after its first native commit. Resolve the
  // scroll parent lazily or a stable ref can permanently capture null.
  get scrollElement(): HTMLDivElement | null {
    const parent = this.threadInnerElement?.parentElement;
    return this.connected && parent instanceof HTMLDivElement && parent.isConnected ? parent : null;
  }
  get contentElement(): HTMLDivElement | null {
    return this.threadInnerElement;
  }
  // Keep one ref per root and row so redraws do not repeat attachment work.
  readonly scrollElementRef = (element?: Element) => {
    this.threadInnerElement = element instanceof HTMLDivElement ? element : null;
    // A retained root can move to another host without changing its identity.
    this.queueScrollElementAttach();
  };
  // Sidebar hosts commit after the pane's update. Attach from the stable DOM
  // ref so a foreign-host re-stamp cannot leave the virtualizer detached.
  private scrollElementAttachQueued = false;
  private queueScrollElementAttach(): void {
    if (this.scrollElementAttachQueued) {
      return;
    }
    this.scrollElementAttachQueued = true;
    queueMicrotask(() => {
      this.scrollElementAttachQueued = false;
      this.renderer.connect();
      if (this.connected && this.virtualizer.scrollElement !== this.scrollElement) {
        this.layout.connect(this.scrollElement, this.callbacks);
        const { _willUpdate: updateVirtualizer } = this.virtualizer;
        updateVirtualizer();
        this.invalidate();
      }
    });
  }
  private readonly rowRefs: TranscriptRowRefs;
  private readonly captureInteractionResize = (event: Event) => {
    const anchor = resolveChatTranscriptInteractionAnchor(event);
    if (!anchor) {
      return;
    }
    this.layout.rowLayout?.invalidateRow(anchor.row.dataset.virtualRowKey);
    this.endAnchor.clear();
    this.prependAnchor.clear();
    this.offsetState.pendingInteractionAnchor = anchor;
    queueMicrotask(() => this.offsetState.pendingInteractionAnchor === anchor && this.invalidate());
  };
  private readonly handleGeometryCommit = (ev: Event) => {
    this.reconcileInteractionResize(ev.target);
    this.viewportRect.commit(!(ev instanceof CustomEvent) || ev.detail?.widthChanged !== false);
  };
  private rowKeys: readonly string[] = [];
  private rowIndexesByKey = new Map<string, number>();
  private messageRowKeysById: ReadonlyMap<string, string> = new Map();
  private readonly prependAnchor = new TranscriptPrependAnchor(
    this.messageElements.elements,
    this.recordEndLayoutCorrection,
  );
  private candidateMessageRowKeysById: ReadonlyMap<string, string> = new Map();
  private candidateMessageRowsByKey: ReadonlyMap<string, string> = new Map();
  private renderPreviousRows: (() => HTMLDivElement) | null = null;
  private focusedRowKey: string | null = null;
  private readonly announcement = new TranscriptAnnouncementState();
  private readonly mcpAppUnmountGate: ReturnType<typeof createMcpAppUnmountGate>;

  constructor(
    // Native geometry and touch-held history must commit before paint.
    private readonly invalidate: () => void,
    initialOffset: number | null = null,
    onInitialOffsetSettled?: (position: ChatSessionScrollPosition) => void,
    private readonly callbacks: TranscriptCallbacks = {},
  ) {
    this.initialRange = new TranscriptInitialRange(
      initialOffset,
      () => this.virtualizer,
      (range) => this.prependAnchor.extractRange(range, this.rowIndexesByKey, this.focusedRowKey),
      invalidate,
      this.layout.rowMinimum,
    );
    this.mcpAppUnmountGate = createMcpAppUnmountGate(invalidate);
    this.positionRail = createPositionRailGutter(
      () => this.scrollElement,
      () => this.threadInnerElement,
      () => this.renderer.columnElement,
    );
    this.viewportRect = new TranscriptViewportRect({
      getScrollElement: () => this.scrollElement,
      getHeaderHeight: () => this.appliedHeaderHeight,
      positionRail: this.positionRail,
      commitComposerResize: () => this.commitComposerResize(true),
      measureConnectedRows: () => this.presentation.measureRows(),
      queueRowMeasure: () => this.presentation.queueRowMeasure(),
      onViewportResize: () => this.callbacks.onViewportResize?.(),
      layout: this.layout,
      invalidate,
    });
    this.virtualizer = new Virtualizer({
      onChange: () => {
        invalidate();
        this.scheduleEndReconcile();
      },
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      initialRect: initialTranscriptRect(),
      initialOffset: initialOffset ?? Number.MAX_SAFE_INTEGER,
      anchorTo: "end",
      scrollToFn: (...args) =>
        scrollTranscriptOffset(this.offsetState, this, this.headerHeight, ...args),
      observeElementRect: this.viewportRect.observe,
      observeElementOffset: (instance, callback) =>
        observeTranscriptOffset(
          {
            state: this.offsetState,
            getScrollElement: () => this.scrollElement,
            prependAnchor: this.prependAnchor,
            endAnchor: this.endAnchor,
            canFollowEnd: () => this.canAutoFollow(),
            isProgrammaticScroll: () => this.isProgrammaticScroll,
            cancelScroll: () => this.cancelScroll(),
            onLayoutCorrection: this.recordEndLayoutCorrection,
            invalidate,
            onOffset: (readerMoved) => {
              // Nested or canceled input must not admit offscreen measurements.
              this.endAnchor.recordViewport(this.scrollElement);
              return readerMoved ? this.initialRange.finish() : undefined;
            },
            onComposerLayout: (changed) => this.commitComposerResize(changed),
            onReaderScroll: (towardEnd) => this.callbacks.onReaderScroll?.(towardEnd),
          },
          instance,
          callback,
        ),
      measureElement: this.layout.measureRow,
      // Row measurements can resize the range and mount new observed rows.
      // Commit those writes outside native resize delivery to avoid WebKit's loop.
      useAnimationFrameWithResizeObserver: true,
      rangeExtractor: (range) => this.initialRange.extract(range),
      // Virtual distance omits real padding, pinning readers ~80px up past scroll.ts's follow-lock.
      // scheduleCommittedChatScroll owns end-follow on content changes and source: "resize".
      // Disable isAtEnd()'s default too; callers must supply an explicit threshold.
      scrollEndThreshold: -1,
      overscan: CHAT_TRANSCRIPT_OVERSCAN,
    });
    // Initial placement owns compensation; an estimated end is not a native scroll target.
    this.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    // A boot re-anchor can precede its native extent; only reader geometry may override it.
    const beforeMeasure = () => this.initialRange.reading && this.offsetState.syncNativeOffset?.();
    this.presentation = createTranscriptPresentation(
      () => this.scrollElement,
      this.virtualizer,
      () => this.rowRefs.elements,
      beforeMeasure,
    );
    this.rowRefs = new TranscriptRowRefs(this.virtualizer, {
      isCurrentRow: (element, key) =>
        this.threadInnerElement?.contains(element) === true && this.rowIndexesByKey.has(key),
      beforeMeasure,
      onMount: () => this.queueLayout(),
    });
    this.scrollRestoreHost = {
      offsetState: this.offsetState,
      virtualizer: this.virtualizer,
      getScrollElement: () => this.scrollElement,
      isContentReady: () => this.layout.ready,
      getRowCount: () => this.rowKeys.length,
      isConnected: () => this.connected,
      pendingScrollFrame: null,
      onReaderScroll: () => {
        if (this.initialRange.pending) {
          this.initialRange.finish();
          this.invalidate();
        }
        this.callbacks.onReaderScroll?.();
      },
    };
    if (initialOffset !== null) {
      this.offsetState.pendingScrollOffset = {
        offset: initialOffset,
        stableFrames: 0,
        zeroMaxFrames: 0,
        onSettled: onInitialOffsetSettled,
      };
    }
  }

  get liveAnnouncementText() {
    return this.announcement.text;
  }

  private stopGeometry?: () => void;

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.renderer.connect();
    const target = this.callbacks.geometryEventTarget;
    this.stopGeometry =
      target && listen(target, SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    // Virtual-core exposes its lifecycle hooks as bound arrow functions.
    const { _didMount: mountVirtualizer } = this.virtualizer;
    this.cleanupVirtualizer = mountVirtualizer();
    if (this.offsetState.pendingScrollOffset) {
      this.invalidate();
    }
  }

  syncViewportGeometry(): void {
    this.layout.sync();
    this.viewportRect.sync();
  }

  private commitComposerResize(changed: boolean): void {
    const correction = this.endAnchor.commitComposerResize(
      this.scrollElement,
      changed,
      this.canAutoFollow(),
      this.offsetState.pendingScrollOffset !== null ||
        this.offsetState.pendingInteractionAnchor !== null ||
        (this.offsetState.scrollCommand !== null &&
          this.offsetState.scrollCommand.target !== "end") ||
        this.offsetState.touchActive,
    );
    if (correction?.resumeFollow) {
      this.callbacks.onReaderScroll?.(true);
    }
  }

  private readonly scheduleEndReconcile = () =>
    this.connected && this.endAnchor.scheduleReconcile(this.reconcileEnd);

  update(): void {
    if (this.threadInnerElement) {
      this.renderer.commit();
    } else if (this.connected) {
      // Empty shells have no native row root; their host still commits readiness.
      this.didCommit();
    }
  }

  private readonly didCommit = () => {
    this.entryAnimations.didCommit();
    this.layout.connect(this.scrollElement, this.callbacks);
    this.positionRail.update();
    const { _willUpdate: updateVirtualizer } = this.virtualizer;
    updateVirtualizer();
    this.rowRefs.observeConnected();
    const interactionResizePending = this.offsetState.pendingInteractionAnchor !== null;
    this.reconcileInteractionResize();
    if (
      !this.offsetState.touchActive &&
      this.prependAnchor.update(this.scrollElement, this.virtualizer, () =>
        this.presentation.measureRows(),
      )
    ) {
      this.offsetState.syncNativeOffset?.();
      this.invalidate();
    }
    if (!this.initialRange.pending || (this.layout.ready && this.rowKeys.length === 0)) {
      applyPendingScrollOffset(this.scrollRestoreHost);
      if (this.initialRange.pending) {
        this.initialRange.finish();
        this.renderer.syncInitialPosition();
      }
    }
    this.queueLayout();
    this.layout.persistRows(this.virtualizer, this.initialRange.pending);
    // Disclosure measurement owns this commit; its sizer lands on the next update.
    if (interactionResizePending) {
      this.endAnchor.cancelReconcile();
    }
  };

  disconnect(): void {
    this.initialRange.disconnect();
    this.renderer.disconnect(() => this.connected);
    this.layout.disconnect();
    this.endAnchor.disconnect();
    this.entryAnimations.disconnect();
    // Clear retires bodies and pending loads; replacement invalidates guarded
    // rows when this presentation reconnects with the same source messages.
    this.expandedAssistantMessages.clear();
    this.expandedAssistantMessages = new Map();
    this.offsetState.scrollCommand = null;
    this.offsetState.maintenanceScrollOffset = null;
    this.prependAnchor.clear();
    this.offsetState.touching = false;
    this.offsetState.touchScrolling = false;
    this.renderPreviousRows = null;
    this.messageReveal.clear();
    if (this.scrollRestoreHost.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.scrollRestoreHost.pendingScrollFrame);
      this.scrollRestoreHost.pendingScrollFrame = null;
    }
    this.threadInnerElement = null;
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.stopGeometry?.();
    this.stopGeometry = undefined;
    this.positionRail.disconnect();
    this.cleanupVirtualizer?.();
    this.cleanupVirtualizer = undefined;
    this.presentation.disconnect();
  }

  dispose(): void {
    this.disconnect();
    // Temporary disconnect preserves restoration facts; terminal disposal releases their owner.
    Object.assign(this.layout, { rows: [], rowLayout: undefined });
    this.renderer.dispose();
    this.messageElements.dispose();
    this.rowRefs.clear();
    this.rowKeys = [];
    this.rowIndexesByKey.clear();
    this.messageRowKeysById = new Map();
    this.prependAnchor.reset();
    this.focusedRowKey = null;
    this.offsetState.pendingScrollOffset = null;
  }

  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => TranscriptContent,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay: JSX.Element = null,
    header: TranscriptHeader | null = null,
    presented: PresentationValue = true,
    applicationContext?: ApplicationContext,
  ): HTMLDivElement {
    this.offsetState.renderedTouchActive = this.offsetState.touchActive;
    // Keep old geometry during the gesture, while still virtualizing that old
    // row model as the reader moves. Only the history insertion is held back.
    if (
      this.prependAnchor.hasPrepend &&
      (this.offsetState.touchActive || this.virtualizer.isScrolling) &&
      !this.offsetState.scrollCommand &&
      !this.offsetState.pendingScrollOffset &&
      this.renderPreviousRows
    ) {
      return this.renderPreviousRows();
    }
    return this.renderCommittedRows(
      {
        rows,
        renderRow,
        announcement,
        announce,
        overlay,
        header,
        messageRows: this.candidateMessageRowKeysById,
        renderKeyRows: this.candidateMessageRowsByKey,
        entryKeys: this.entryAnimations.projectedKeys,
        presented,
        applicationContext,
      },
      true,
    );
  }

  /** Render one selected projection without admitting a held history insertion. */
  private renderCommittedRows<T>(
    snapshot: TranscriptRenderSnapshot<T>,
    capturePrepend: boolean,
  ): HTMLDivElement {
    const { rows, renderRow, announcement, announce, overlay, header, messageRows, renderKeyRows } =
      snapshot;
    const rowModelChanged =
      rows.length !== this.rowKeys.length ||
      rows.some((row, index) => row.key !== this.rowKeys[index]);
    const nextKeys = rowModelChanged ? rows.map((row) => row.key) : this.rowKeys;
    const virtualizer = this.virtualizer;
    const nextRowKeys = rowModelChanged
      ? nextKeys
      : virtualizer.getVirtualItems().map(({ index }) => rows[index]!.key);
    return this.mcpAppUnmountGate.render(
      rowModelChanged ? nextKeys : JSON.stringify(nextRowKeys),
      () => {
        // Rows, lookup maps, and the retained renderer commit together. A
        // teardown-pending candidate must never replace the displayed model.
        this.entryAnimations.sync(
          snapshot.entryKeys,
          announce && !this.offsetState.pendingScrollOffset,
        );
        this.messageRowKeysById = messageRows;
        this.layout.rows = rows;
        this.prependAnchor.committedMessageRows = renderKeyRows;
        this.renderPreviousRows = () => this.renderCommittedRows(snapshot, false);
        // Capture only after the unmount gate permits the projection to commit.
        if (capturePrepend) {
          this.prependAnchor.capture(
            this.scrollElement,
            Boolean(
              this.offsetState.pendingScrollOffset ||
              this.offsetState.scrollCommand ||
              this.offsetState.pendingInteractionAnchor,
            ),
            // A peer append can add attribution above a bubble inside an
            // existing run row. Row-height compensation alone cannot hold it.
            rowModelChanged && !this.canAutoFollow(),
          );
        }
        // Structural changes can alter the end without a virtualizer notification.
        if (rowModelChanged || this.headerHeight !== (header?.height ?? 0)) {
          this.renderer.queueAfterCommit(this.scheduleEndReconcile);
        }
        this.headerHeight = header?.height ?? 0;
        if (rowModelChanged) {
          this.syncRows(nextKeys);
        } else {
          this.appliedHeaderHeight = reconcileTranscriptHeaderMargin(
            virtualizer,
            this.headerHeight,
            this.appliedHeaderHeight,
          );
        }
        this.announcement.sync(announcement, announce);
        return this.renderer.render({
          applicationContext: snapshot.applicationContext,
          messageElements: this.messageElements,
          layout: this.layout,
          headerHeight: this.headerHeight,
          presented: snapshot.presented,
          initialPositionPending: () => this.initialRange.pending,
          onCommit: () => this.connected && this.didCommit(),
          rows,
          getContent: (index) => renderRow(rows[index]!),
          virtualizer,
          overlay,
          header: header?.content ?? null,
          scrollElementRef: this.scrollElementRef,
          captureInteractionResize: this.captureInteractionResize,
          measureRowRefFor: (key) => this.rowRefs.forKey(key),
          measureRows:
            // The first correction reveals new rows; their real sizes must land before retiring the anchor.
            this.initialRange.measuring ||
            this.prependAnchor.messageKey !== null ||
            this.offsetState.scrollCommand?.target === "message" ||
            this.offsetState.scrollCommand?.target === "index",
        });
      },
      () =>
        leavingTranscriptMcpAppRows(this.threadInnerElement, () =>
          rowModelChanged
            ? previewTranscriptRowKeys(virtualizer, nextKeys, this.focusedRowKey)
            : new Set(nextRowKeys),
        ),
      {
        afterCommit: (effect) => void this.renderer.afterCommit(effect),
      },
      // SAFETY: Both gate branches return this session's Solid root while MCP views retire.
    ) as HTMLDivElement;
  }

  get isMaintenanceScroll(): boolean {
    return (
      // Intermediate end-command movement remains owned until native input cancels it.
      (this.offsetState.scrollCommand?.target === "end" && this.canAutoFollow()) ||
      (this.endAnchor.isResizeAnchor(this.scrollElement) && this.canAutoFollow()) ||
      isTranscriptMaintenanceScroll(this.offsetState, this.scrollElement)
    );
  }

  get isProgrammaticScroll(): boolean {
    return isTranscriptProgrammaticScroll(this.offsetState, this.scrollElement);
  }

  get isPositionSettled(): boolean {
    return this.layout.ready && !this.initialRange.pending && !this.offsetState.pendingScrollOffset;
  }

  private canAutoFollow(): boolean {
    const command = this.offsetState.scrollCommand;
    return (!command || command.target === "end") && (this.callbacks.canFollowEnd?.() ?? true);
  }

  scrollToEnd({ source = "manual", behavior = "auto" }: ChatScrollToEndOptions = {}): boolean {
    // Hydration/resize follow cannot replace a saved reader. A new latest
    // command intentionally supersedes restoration.
    if (source === "auto" && (this.offsetState.pendingScrollOffset || !this.canAutoFollow())) {
      return false;
    }
    if (source !== "auto") {
      this.initialRange.finish();
    }
    scrollTranscriptToEnd(
      this.offsetState,
      this.virtualizer,
      { source, behavior },
      () => this.cancelScroll(),
      () => this.presentation.queueRowMeasure(),
    );
    // A smooth no-op emits no native idle event to capture the end. Preserve
    // that actual resting edge before a later row measurement grows the range.
    if (behavior !== "smooth" || this.endAnchor.recordViewport(this.scrollElement)) {
      this.endAnchor.capture(this.scrollElement);
    }
    return true;
  }

  cancelScroll(): void {
    this.endAnchor.clear();
    this.prependAnchor.clear();
    if (this.offsetState.scrollCommand === null && !this.offsetState.pendingScrollOffset) {
      return;
    }
    const measureSkippedRows = this.offsetState.scrollCommand?.behavior === "smooth";
    this.offsetState.scrollCommand = null;
    this.offsetState.pendingScrollOffset = null;
    if (this.scrollRestoreHost.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.scrollRestoreHost.pendingScrollFrame);
      this.scrollRestoreHost.pendingScrollFrame = null;
    }
    // The smooth journey may already be automatic when its skipped sizes settle.
    if (measureSkippedRows) {
      this.presentation.measureRowsWithoutScrollAdjustment();
    }
    const element = this.scrollElement;
    if (element) {
      // Cancellation is one instant target replacement, never the multi-frame
      // restoration API.
      this.virtualizer.scrollToOffset(element.scrollTop, { behavior: "instant" });
    }
  }

  syncMessageRows(
    messageRowKeysById: ReadonlyMap<string, string>,
    messageRowsByKey: ReadonlyMap<string, string>,
  ): void {
    // The projection hands off finished indexes and never mutates them afterward.
    this.candidateMessageRowKeysById = messageRowKeysById;
    this.candidateMessageRowsByKey = messageRowsByKey;
    this.prependAnchor.messageKeys = messageRowsByKey;
  }

  activeMessageId(messageIds: readonly string[]): string | null {
    return activeTranscriptMessageId(
      this.scrollElement,
      this.virtualizer,
      messageIds,
      this.messageRowKeysById,
      this.rowIndexesByKey,
    );
  }

  revealMessage(messageId: string): boolean {
    const rowKey =
      this.messageRowKeysById.get(messageId) ?? this.candidateMessageRowKeysById.get(messageId);
    if (!rowKey) {
      return false;
    }
    this.initialRange.finish();
    this.cancelScroll();
    // History can be projected while scrolling or MCP teardown still holds the old rows.
    this.offsetState.scrollCommand = {
      behavior: resolveScrollBehavior(),
      target: "message",
      messageId,
    };
    const rowIndex = this.rowIndexesByKey.get(rowKey);
    if (rowIndex !== undefined) {
      this.virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }
    this.invalidate();
    this.queueLayout();
    return true;
  }

  restoreScrollOffset(
    offset: number,
    onSettled?: (position: ChatSessionScrollPosition) => void,
  ): void {
    this.cancelScroll();
    this.initialRange.finish();
    this.offsetState.pendingScrollOffset = { offset, stableFrames: 0, zeroMaxFrames: 0, onSettled };
    if (this.connected) {
      this.invalidate();
    }
  }

  handleFocusIn(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.target);
  }

  handleFocusOut(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.relatedTarget);
  }

  private reconcileInteractionResize(sidebarCommitTarget?: EventTarget | null): void {
    if (
      reconcileChatTranscriptInteractionResize(
        this.offsetState.pendingInteractionAnchor,
        sidebarCommitTarget,
        this.scrollElement,
        this.virtualizer,
      )
    ) {
      this.offsetState.pendingInteractionAnchor = null;
    }
  }

  private syncRows(nextKeys: readonly string[]): void {
    this.rowKeys = nextKeys;
    this.rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    // The header margin must land in the same setOptions as the key change:
    // the edge-key re-anchor uses absolute offsets, so a prepend that also
    // removes the header (exhausted history) compensates in one adjustment.
    const scrollMargin =
      this.virtualizer.options.scrollMargin + this.headerHeight - this.appliedHeaderHeight;
    this.appliedHeaderHeight = this.headerHeight;
    this.virtualizer.setOptions({
      ...this.virtualizer.options,
      count: nextKeys.length,
      getItemKey: (index) => nextKeys[index]!,
      rangeExtractor: (range) => this.initialRange.extract(range),
      scrollMargin,
    });
  }

  private queueLayout(): void {
    if (
      (this.initialRange.measuring && this.rowKeys.length) ||
      this.offsetState.scrollCommand?.target === "message"
    ) {
      this.renderer.queueAfterCommit(this.completeLayout);
    }
  }

  private readonly completeLayout = () => {
    if (!this.connected || this.virtualizer.scrollElement !== this.scrollElement) {
      return;
    }
    this.messageReveal.complete(
      this.threadInnerElement,
      this.offsetState,
      this.virtualizer,
      this.messageRowKeysById,
      this.rowIndexesByKey,
    );
    if (!this.initialRange.measuring || !this.rowKeys.length || !this.scrollElement?.clientHeight) {
      return;
    }
    const measured = this.presentation.measureRows();
    if ((this.initialRange.pending && this.initialRange.extend(this.scrollElement)) || measured) {
      this.invalidate();
      return;
    }
    if (this.offsetState.pendingScrollOffset) {
      applyPendingScrollOffset(this.scrollRestoreHost);
      return;
    }
    if (
      (this.initialRange.pending || this.offsetState.scrollCommand?.target === "end") &&
      this.canAutoFollow() &&
      !(this.offsetState.pendingInteractionAnchor || this.offsetState.touchActive)
    ) {
      const behavior = this.offsetState.scrollCommand?.behavior ?? "instant";
      this.scrollToEnd({ source: "auto", behavior });
      this.offsetState.syncNativeOffset?.();
    }
    if (isTranscriptRangeCommitted(this.threadInnerElement, this.virtualizer)) {
      this.initialRange.complete();
      this.renderer.syncInitialPosition();
    }
    this.invalidate();
  };
}
