// Per-session virtualizer host: scroll anchoring, measurement, and row sync
// for one transcript. Owned and swapped by ChatTranscriptController.
import { VirtualizerController } from "@tanstack/lit-virtual";
import {
  type Range,
  measureElement as measureVirtualElement,
  observeElementRect,
} from "@tanstack/virtual-core";
import {
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { resolveScrollBehavior } from "../../../lib/scroll-behavior.ts";
import type { AssistantMessageExpansionState } from "../chat-thread.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  type ChatSessionScrollPosition,
  type ChatScrollToEndOptions,
} from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { ChatMessageReveal } from "./chat-message-reveal.ts";
import {
  TranscriptAnnouncementState,
  type TranscriptAnnouncement,
} from "./chat-transcript-announcement.ts";
import {
  initialTranscriptRect,
  maxTranscriptScrollOffset,
  measureConnectedTranscriptRows,
  resolveTranscriptScrollMargin,
  PositionRailGutterController,
  syncScrollMargin,
} from "./chat-transcript-geometry.ts";
import { reconcileTranscriptHeaderMargin } from "./chat-transcript-header.ts";
import {
  reconcileChatTranscriptInteractionResize,
  resolveChatTranscriptInteractionAnchor,
} from "./chat-transcript-interaction-anchor.ts";
import { renderChatTranscriptLayout, type TranscriptRow } from "./chat-transcript-layout.ts";
import {
  createTranscriptOffsetState,
  observeTranscriptOffset,
} from "./chat-transcript-offset-observer.ts";
import { activeTranscriptMessageId } from "./chat-transcript-position.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  extractTranscriptRange,
  previewTranscriptRowKeys,
  focusedTranscriptRowKey,
} from "./chat-transcript-range.ts";
import {
  applyPendingScrollOffset,
  type TranscriptScrollRestoreHost,
} from "./chat-transcript-scroll-restore.ts";
import {
  CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
  CHAT_TRANSCRIPT_OVERSCAN,
  type ChatTranscriptSession,
  type TranscriptCallbacks,
  type TranscriptHeader,
  type TranscriptRenderSnapshot,
} from "./chat-transcript-session.ts";

export class ChatSessionVirtualizerHost implements ReactiveControllerHost, ChatTranscriptSession {
  private readonly offsetState = createTranscriptOffsetState();
  expandedAssistantMessages = new Map<string, AssistantMessageExpansionState>();
  private readonly controllers = new Set<ReactiveController>();
  private readonly positionRail: PositionRailGutterController;
  private readonly virtualizerController: VirtualizerController<HTMLDivElement, HTMLElement>;
  private threadInnerElement: HTMLDivElement | null = null;
  private connected = false;
  private observedWidth: number | null = null;
  private observedHeight: number | null = null;
  private contentReady = false;
  // The in-flow history header's fixed height, folded into scrollMargin.
  // appliedHeaderHeight is what the current virtualizer margin already carries.
  private headerHeight = 0;
  private appliedHeaderHeight = 0;
  private implicitEndAnchorPending: boolean;
  private endAnchor: number | null = null;
  private pendingScrollFrame: number | null = null;
  private readonly scrollRestoreHost: TranscriptScrollRestoreHost;
  private readonly messageReveal = new ChatMessageReveal();
  // Lit calls refs before newly rendered nodes are connected. Resolve the
  // scroll parent lazily or a stable ref can permanently capture null.
  get scrollElement(): HTMLDivElement | null {
    const parent = this.threadInnerElement?.parentElement;
    return this.connected && parent instanceof HTMLDivElement && parent.isConnected ? parent : null;
  }
  // Stable Lit refs: inline arrows change identity per render, making Lit
  // re-invoke them for every visible row and re-measure each row every render.
  // Lit tracks the last element per callback, so each row needs its own.
  readonly scrollElementRef = (element?: Element) => {
    const next = element instanceof HTMLDivElement ? element : null;
    if (next === this.threadInnerElement) {
      return;
    }
    this.threadInnerElement = next;
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
      const instance = this.virtualizerController.getVirtualizer();
      if (this.connected && instance.scrollElement !== this.scrollElement) {
        this.virtualizerController.hostUpdated();
        this.host.requestUpdate();
      }
    });
  }
  private readonly measureRowRefs = new Map<string, (element?: Element) => void>();
  private pruneDetachedRowsQueued = false;
  private pendingRowMeasureFrame: number | null = null;
  private readonly captureInteractionResize = (event: Event) => {
    const anchor = resolveChatTranscriptInteractionAnchor(event);
    if (!anchor) {
      return;
    }
    this.endAnchor = null;
    this.offsetState.pendingInteractionAnchor = anchor;
    queueMicrotask(
      () => this.offsetState.pendingInteractionAnchor === anchor && this.host.requestUpdate(),
    );
  };
  private measureConnectedRows(): void {
    // Native input can land after takeover but before its offset observer.
    // Refresh the offset and direction before compensating deferred row growth.
    this.offsetState.syncNativeOffset?.();
    measureConnectedTranscriptRows(this.scrollElement, this.virtualizerController.getVirtualizer());
  }
  private readonly handleGeometryCommit = (event: Event) => {
    this.reconcileInteractionResize(event.target);
    this.positionRail.sync();
    if (event instanceof CustomEvent && event.detail?.widthChanged === false) {
      return;
    }
    const rect = this.scrollElement?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }
    // The viewport observer must not repeat this committed width's row scan.
    this.observedWidth = Math.round(rect.width);
    this.measureConnectedRows();
  };
  private queueConnectedRowMeasure(): void {
    if (this.pendingRowMeasureFrame !== null) {
      return;
    }
    const element = this.scrollElement;
    this.pendingRowMeasureFrame = requestAnimationFrame(() => {
      this.pendingRowMeasureFrame = null;
      if (element === this.scrollElement) {
        this.measureConnectedRows();
      }
    });
  }
  private measureRowRefFor(key: string): (element?: Element) => void {
    let callback = this.measureRowRefs.get(key);
    if (!callback) {
      callback = (element?: Element) => {
        if (element instanceof HTMLElement) {
          if (
            this.offsetState.scrollCommand?.target === "message" &&
            this.messageRowKeysById.get(this.offsetState.scrollCommand.messageId) === key
          ) {
            // The parent update can finish before a virtualized target mounts.
            queueMicrotask(() => this.completeMessageReveal());
          }
          if (element.isConnected) {
            this.virtualizerController.getVirtualizer().measureElement(element);
          } else {
            // Lit invokes refs before the row is connected. Measuring a new
            // key there records offsetHeight=0 and corrupts the virtual range
            // until ResizeObserver catches up.
            queueMicrotask(() => {
              if (
                element.isConnected &&
                this.threadInnerElement?.contains(element) &&
                element.dataset.virtualRowKey === key &&
                this.rowIndexesByKey.has(key)
              ) {
                this.virtualizerController.getVirtualizer().measureElement(element);
              }
            });
          }
          return;
        }
        // Re-stamps (e.g. the chat<->dashboard face switch) re-invoke each
        // stable row ref as an (undefined, element) pair while the new subtree
        // is still detached. measureElement(null) prunes every disconnected
        // row, so calling it synchronously unobserves just-registered sibling
        // rows and freezes their heights at the old pane width (overlapping
        // bubbles). Defer until the commit lands so only removed rows prune.
        if (this.pruneDetachedRowsQueued) {
          return;
        }
        this.pruneDetachedRowsQueued = true;
        queueMicrotask(() => {
          this.pruneDetachedRowsQueued = false;
          this.virtualizerController.getVirtualizer().measureElement(null);
        });
      };
      this.measureRowRefs.set(key, callback);
    }
    return callback;
  }
  private rowKeys: readonly string[] = [];
  private rowIndexesByKey = new Map<string, number>();
  private messageRowKeysById: ReadonlyMap<string, string> = new Map();
  private readonly prependAnchor = new TranscriptPrependAnchor();
  private candidateMessageRowKeysById: ReadonlyMap<string, string> = new Map();
  private candidateMessageRowsByKey: ReadonlyMap<string, string> = new Map();
  private committedMessageRowsByKey: ReadonlyMap<string, string> = new Map();
  private renderPreviousRows: (() => TemplateResult) | null = null;
  private focusedRowKey: string | null = null;
  private readonly announcement = new TranscriptAnnouncementState();
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);

  constructor(
    private readonly host: ReactiveControllerHost,
    initialOffset: number | null = null,
    onInitialOffsetSettled?: (position: ChatSessionScrollPosition) => void,
    private readonly callbacks: TranscriptCallbacks = {},
  ) {
    this.positionRail = new PositionRailGutterController(this, () => this.threadInnerElement);
    this.implicitEndAnchorPending = initialOffset === null;
    this.virtualizerController = new VirtualizerController(this, {
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      getItemKey: () => "",
      initialRect: initialTranscriptRect(host),
      initialOffset: initialOffset ?? Number.MAX_SAFE_INTEGER,
      anchorTo: "end",
      followOnAppend: false,
      observeElementRect: (instance, callback) =>
        observeElementRect(instance, (rect) => {
          // Hidden tabs and detached faces are not viewport resizes. Keep the
          // last measurable geometry until this session's scroller returns.
          if (instance.scrollElement !== this.scrollElement || !rect.width || !rect.height) {
            return;
          }
          const previousHeight = this.observedHeight;
          const widthChanged = this.observedWidth !== null && this.observedWidth !== rect.width;
          const heightChanged = previousHeight !== null && previousHeight !== rect.height;
          this.observedWidth = rect.width;
          this.observedHeight = rect.height;
          this.positionRail.sync();
          // appliedHeaderHeight, not headerHeight: only the render paths fold a
          // header toggle into the margin, because they own its compensation.
          syncScrollMargin(instance.scrollElement, instance, this.appliedHeaderHeight);
          callback(rect);
          if (widthChanged) {
            // Keep stale offscreen sizes as estimates — a full measure() wipe
            // has no scroll compensation and teleports the reader. resizeItem
            // re-seeds connected rows with fold-based compensation, so the
            // anchor row holds still; offscreen rows correct as they connect.
            this.measureConnectedRows();
            this.queueConnectedRowMeasure();
          }
          if (widthChanged || heightChanged) {
            this.callbacks.onViewportResize?.();
            this.host.requestUpdate();
          }
        }),
      observeElementOffset: (instance, callback) =>
        observeTranscriptOffset(
          {
            state: this.offsetState,
            getScrollElement: () => this.scrollElement,
            prependAnchor: this.prependAnchor,
            cancelScroll: () => this.cancelScroll(),
            requestUpdate: () => this.host.requestUpdate(),
            onReaderScroll: () => this.callbacks.onReaderScroll?.(),
          },
          instance,
          callback,
        ),
      measureElement: measureVirtualElement,
      rangeExtractor: (range) => this.extractAnchoredRange(range, this.rowIndexesByKey),
      // Virtual distance omits real padding, pinning readers ~80px up past scroll.ts's follow-lock.
      // scheduleCommittedChatScroll owns end-follow on content changes and source: "resize".
      // Disable isAtEnd()'s default too; callers must supply an explicit threshold.
      scrollEndThreshold: -1,
      overscan: CHAT_TRANSCRIPT_OVERSCAN,
    });
    this.scrollRestoreHost = {
      offsetState: this.offsetState,
      virtualizer: this.virtualizerController.getVirtualizer(),
      getScrollElement: () => this.scrollElement,
      isContentReady: () => this.contentReady,
      getRowCount: () => this.rowKeys.length,
      isConnected: () => this.connected,
      getPendingScrollFrame: () => this.pendingScrollFrame,
      setPendingScrollFrame: (frame) => {
        this.pendingScrollFrame = frame;
      },
      requestUpdate: this.requestUpdate,
      onReaderScroll: () => this.callbacks.onReaderScroll?.(),
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

  get updateComplete() {
    return this.host.updateComplete;
  }

  get liveAnnouncementText() {
    return this.announcement.text;
  }

  requestUpdate = () => this.host.requestUpdate();

  addController(controller: ReactiveController): void {
    this.controllers.add(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.delete(controller);
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    if (this.host instanceof HTMLElement) {
      this.host.addEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    }
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    if (this.offsetState.pendingScrollOffset) {
      this.host.requestUpdate();
    }
  }

  update(): void {
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    const interactionResizePending = this.offsetState.pendingInteractionAnchor !== null;
    this.reconcileInteractionResize();
    if (
      !this.offsetState.touching &&
      !this.offsetState.touchScrolling &&
      this.prependAnchor.update(
        this.scrollElement,
        this.virtualizerController.getVirtualizer(),
        () => this.measureConnectedRows(),
      )
    ) {
      this.offsetState.syncNativeOffset?.();
      this.host.requestUpdate();
    }
    this.reconcileImplicitEndAnchor();
    applyPendingScrollOffset(this.scrollRestoreHost);
    // Disclosure measurement owns this commit; its sizer lands on the next update.
    if (!interactionResizePending) {
      this.reconcileEndAnchor();
    }
  }

  disconnect(): void {
    // Clear retires bodies and pending loads; replacement invalidates guarded
    // rows when this presentation reconnects with the same source messages.
    this.expandedAssistantMessages.clear();
    this.expandedAssistantMessages = new Map();
    this.offsetState.scrollCommand = null;
    this.prependAnchor.clear();
    this.offsetState.touching = false;
    this.offsetState.touchScrolling = false;
    this.renderPreviousRows = null;
    this.messageReveal.clear();
    if (this.pendingRowMeasureFrame !== null) {
      cancelAnimationFrame(this.pendingRowMeasureFrame);
      this.pendingRowMeasureFrame = null;
    }
    if (this.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.pendingScrollFrame);
      this.pendingScrollFrame = null;
    }
    if (!this.connected) {
      this.threadInnerElement = null;
      return;
    }
    this.connected = false;
    if (this.host instanceof HTMLElement) {
      this.host.removeEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    }
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.threadInnerElement = null;
  }

  dispose(): void {
    this.disconnect();
    this.measureRowRefs.clear();
    this.rowKeys = [];
    this.rowIndexesByKey.clear();
    this.messageRowKeysById = new Map();
    this.prependAnchor.reset();
    this.focusedRowKey = null;
    this.offsetState.pendingScrollOffset = null;
  }

  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay: unknown = nothing,
    header: TranscriptHeader | null = null,
  ): TemplateResult {
    const virtualizer = this.virtualizerController.getVirtualizer();
    // Keep old geometry during the gesture, while still virtualizing that old
    // row model as the reader moves. Only the history insertion is held back.
    if (
      this.prependAnchor.hasPrepend &&
      (this.offsetState.touching || this.offsetState.touchScrolling || virtualizer.isScrolling) &&
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
      },
      true,
    );
  }

  /** Render one selected projection without admitting a held history insertion. */
  private renderCommittedRows<T>(
    snapshot: TranscriptRenderSnapshot<T>,
    capturePrepend: boolean,
  ): TemplateResult {
    const { rows, renderRow, announcement, announce, overlay, header, messageRows, renderKeyRows } =
      snapshot;
    const rowModelChanged =
      rows.length !== this.rowKeys.length ||
      rows.some((row, index) => row.key !== this.rowKeys[index]);
    const nextKeys = rowModelChanged ? rows.map((row) => row.key) : this.rowKeys;
    const virtualizer = this.virtualizerController.getVirtualizer();
    const nextRowKeys = rowModelChanged
      ? nextKeys
      : virtualizer.getVirtualItems().flatMap(({ index }) => rows[index]?.key ?? []);
    return this.mcpAppUnmountGate.render(
      rowModelChanged ? nextKeys : JSON.stringify(nextRowKeys),
      () => {
        // Rows, lookup maps, and the retained renderer commit together. A
        // teardown-pending candidate must never replace the displayed model.
        this.messageRowKeysById = messageRows;
        this.committedMessageRowsByKey = renderKeyRows;
        this.renderPreviousRows = () => this.renderCommittedRows(snapshot, false);
        // Capture only after the unmount gate permits the projection to commit.
        if (capturePrepend) {
          this.prependAnchor.capture(
            this.scrollElement,
            Boolean(this.offsetState.pendingScrollOffset || this.offsetState.scrollCommand),
          );
        }
        this.headerHeight = header?.height ?? 0;
        if (rowModelChanged) {
          this.syncRows(nextKeys);
        } else {
          this.appliedHeaderHeight = reconcileTranscriptHeaderMargin(
            virtualizer,
            this.scrollElement,
            this.headerHeight,
            this.appliedHeaderHeight,
          );
        }
        this.announcement.sync(announcement, announce);
        return renderChatTranscriptLayout({
          rows,
          renderRow,
          virtualizer,
          overlay,
          header: header?.template ?? nothing,
          scrollElementRef: this.scrollElementRef,
          captureInteractionResize: this.captureInteractionResize,
          measureRowRefFor: (key) => this.measureRowRefFor(key),
        });
      },
      () => {
        const appRows = new Set(
          [
            ...(this.threadInnerElement?.querySelectorAll<HTMLElement>("mcp-app-view") ?? []),
          ].flatMap((app) => app.closest<HTMLElement>(".chat-virtual-row") ?? []),
        );
        if (appRows.size === 0) {
          return [];
        }
        const nextRenderedKeys = rowModelChanged
          ? previewTranscriptRowKeys(virtualizer, nextKeys, this.focusedRowKey)
          : new Set(nextRowKeys);
        return [...appRows].filter((row) => !nextRenderedKeys.has(row.dataset.virtualRowKey ?? ""));
      },
      // SAFETY: the gate returns renderValue's output, always the renderChatTranscriptLayout TemplateResult here.
    ) as TemplateResult;
  }

  get isProgrammaticScroll(): boolean {
    const element = this.scrollElement;
    // Lit's scroll listener can precede TanStack's offset observer. Read the
    // committed viewport so the final event publishes the settled end policy.
    const distanceFromEnd = (maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0);
    return (
      this.offsetState.pendingScrollOffset !== null ||
      (this.offsetState.scrollCommand !== null &&
        distanceFromEnd > CHAT_TRANSCRIPT_END_THRESHOLD_PX)
    );
  }

  scrollToEnd({ source = "manual", behavior = "auto" }: ChatScrollToEndOptions = {}): boolean {
    // Hydration/resize follow cannot replace a saved reader. A new latest
    // command intentionally supersedes restoration.
    if (source === "auto" && this.offsetState.pendingScrollOffset) {
      return false;
    }
    this.cancelScroll();
    this.offsetState.scrollCommand = {
      behavior,
      target: "end",
    };
    this.virtualizerController.getVirtualizer().scrollToEnd({ behavior });
    if (behavior !== "smooth") {
      this.endAnchor = maxTranscriptScrollOffset(this.scrollElement);
    }
    return true;
  }

  private reconcileEndAnchor(): void {
    const { pendingScrollOffset, touching, touchScrolling } = this.offsetState;
    if (pendingScrollOffset || touching || touchScrolling) {
      return;
    }
    const element = this.scrollElement;
    const max = maxTranscriptScrollOffset(element);
    if (!element || max === null) {
      return;
    }
    if (Math.abs(max - element.scrollTop) <= 1) {
      this.endAnchor = max;
      return;
    }
    if (this.endAnchor === null) {
      return;
    }
    if (Math.abs(element.scrollTop - this.endAnchor) > 1) {
      this.endAnchor = null;
      return;
    }
    // Row measurement can move the end after a follow or without a new command.
    this.scrollToEnd({ source: "auto", behavior: "auto" });
  }

  private cancelScroll(): void {
    this.endAnchor = null;
    this.prependAnchor.clear();
    if (this.offsetState.scrollCommand === null && !this.offsetState.pendingScrollOffset) {
      return;
    }
    // Only smooth commands skip row measurements. Replaying ordinary auto
    // scrolling's overscan sizes can move an already settled end anchor.
    if (this.offsetState.scrollCommand?.behavior === "smooth") {
      this.queueConnectedRowMeasure();
    }
    this.offsetState.scrollCommand = null;
    this.offsetState.pendingScrollOffset = null;
    if (this.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.pendingScrollFrame);
      this.pendingScrollFrame = null;
    }
    const element = this.scrollElement;
    if (element) {
      // Cancellation is one instant target replacement, never the multi-frame
      // restoration API.
      this.virtualizerController
        .getVirtualizer()
        .scrollToOffset(element.scrollTop, { behavior: "instant" });
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
      this.virtualizerController.getVirtualizer(),
      messageIds,
      this.messageRowKeysById,
      this.rowIndexesByKey,
    );
  }

  revealMessage(messageId: string): boolean {
    const rowKey = this.messageRowKeysById.get(messageId);
    const rowIndex = rowKey ? this.rowIndexesByKey.get(rowKey) : undefined;
    if (rowIndex === undefined) {
      return false;
    }
    this.cancelScroll();
    this.offsetState.scrollCommand = {
      behavior: resolveScrollBehavior(),
      target: "message",
      messageId,
    };
    this.virtualizerController.getVirtualizer().scrollToIndex(rowIndex, { align: "center" });
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => this.completeMessageReveal());
    return true;
  }

  private completeMessageReveal(): void {
    const command = this.offsetState.scrollCommand;
    if (
      command?.target === "message" &&
      this.messageReveal.reveal(this.threadInnerElement, command)
    ) {
      this.offsetState.scrollCommand = { behavior: command.behavior, target: "index" };
    }
  }

  setContentReady(ready: boolean): void {
    this.contentReady = ready;
  }

  restoreScrollOffset(
    offset: number,
    onSettled?: (position: ChatSessionScrollPosition) => void,
  ): void {
    this.cancelScroll();
    this.implicitEndAnchorPending = false;
    this.offsetState.pendingScrollOffset = { offset, stableFrames: 0, zeroMaxFrames: 0, onSettled };
    if (this.connected) {
      this.host.requestUpdate();
    }
  }

  handleFocusIn(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.target);
  }

  handleFocusOut(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.relatedTarget);
  }

  private reconcileInteractionResize(sidebarCommitTarget?: EventTarget | null): void {
    const virtualizer = this.virtualizerController.getVirtualizer();
    if (
      reconcileChatTranscriptInteractionResize(
        this.offsetState.pendingInteractionAnchor,
        sidebarCommitTarget,
        this.scrollElement,
        virtualizer,
      )
    ) {
      this.offsetState.pendingInteractionAnchor = null;
    }
  }

  /** Preserve the retained bubble even when a deferred offset selects another range. */
  private extractAnchoredRange(range: Range, indexes: ReadonlyMap<string, number>): number[] {
    const visible = extractTranscriptRange(range, indexes, this.focusedRowKey);
    const messageKey = this.prependAnchor.messageKey;
    const rowKey =
      (messageKey === null ? null : this.committedMessageRowsByKey.get(messageKey)) ??
      this.prependAnchor.rowKey;
    const anchorIndex = rowKey === null ? undefined : indexes.get(rowKey);
    return anchorIndex === undefined || visible.includes(anchorIndex)
      ? visible
      : [...visible, anchorIndex].toSorted((left, right) => left - right);
  }

  private syncRows(nextKeys: readonly string[]): void {
    const virtualizer = this.virtualizerController.getVirtualizer();
    const typingAdded =
      !this.rowIndexesByKey.has("presence:typing") && nextKeys.includes("presence:typing");
    const followTyping =
      typingAdded &&
      !this.offsetState.pendingScrollOffset &&
      virtualizer.isAtEnd(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    this.rowKeys = Object.freeze(nextKeys);
    const rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    this.rowIndexesByKey = rowIndexesByKey;
    for (const key of this.measureRowRefs.keys()) {
      if (!this.rowIndexesByKey.has(key)) {
        this.measureRowRefs.delete(key);
      }
    }
    // The header margin must land in the same setOptions as the key change:
    // the edge-key re-anchor uses absolute offsets, so a prepend that also
    // removes the header (exhausted history) compensates in one adjustment.
    this.appliedHeaderHeight = this.headerHeight;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: nextKeys.length,
      getItemKey: (index) => nextKeys[index] ?? `missing:${index}`,
      followOnAppend: false,
      rangeExtractor: (range) => this.extractAnchoredRange(range, rowIndexesByKey),
      scrollMargin: resolveTranscriptScrollMargin(this.scrollElement, this.headerHeight),
    });
    if (followTyping) {
      this.cancelScroll();
      this.offsetState.scrollCommand = { behavior: "auto", target: "index" };
      virtualizer.scrollToIndex(nextKeys.indexOf("presence:typing"), { align: "end" });
    }
  }

  private reconcileImplicitEndAnchor(): void {
    if (!this.implicitEndAnchorPending || !this.connected || !this.contentReady) {
      return;
    }
    const maxOffset = maxTranscriptScrollOffset(this.scrollElement);
    const virtualizer = this.virtualizerController.getVirtualizer();
    const scrollOffset = virtualizer.scrollOffset;
    if (maxOffset === null || scrollOffset === null) {
      return;
    }
    if (scrollOffset >= 0 && scrollOffset <= maxOffset) {
      this.implicitEndAnchorPending = false;
      return;
    }
    if (maxOffset !== 0) {
      return;
    }
    this.implicitEndAnchorPending = false;
    // The DOM clamps an underfilled end anchor to zero without a scroll event,
    // so TanStack cannot reconcile its maximum-integer initial offset itself.
    virtualizer.scrollOffset = 0;
    virtualizer.scrollToOffset(0);
    this.host.requestUpdate();
  }
}
