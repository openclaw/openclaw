// Per-session virtualizer host: scroll anchoring, measurement, and row sync
// for one transcript. Owned and swapped by ChatTranscriptController.
import { Virtualizer } from "@tanstack/virtual-core";
import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { resolveScrollBehavior } from "../../../lib/scroll-behavior.ts";
import type { PresentationValue } from "../../../lit/presentation-binding.ts";
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
  measureConnectedTranscriptRows,
  measureTranscriptRow,
  resolveTranscriptScrollMargin,
  PositionRailGutterController,
} from "./chat-transcript-geometry.ts";
import { reconcileTranscriptHeaderMargin } from "./chat-transcript-header.ts";
import {
  reconcileChatTranscriptInteractionResize,
  resolveChatTranscriptInteractionAnchor,
} from "./chat-transcript-interaction-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
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
import { previewTranscriptRowKeys, focusedTranscriptRowKey } from "./chat-transcript-range.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import {
  applyPendingScrollOffset,
  type TranscriptScrollRestoreHost,
} from "./chat-transcript-scroll-restore.ts";
import {
  CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
  CHAT_TRANSCRIPT_OVERSCAN,
  TranscriptPresentation,
  type ChatTranscriptSession,
  type TranscriptCallbacks,
  type TranscriptHeader,
  type TranscriptRenderSnapshot,
} from "./chat-transcript-session.ts";
import { TranscriptViewportRect } from "./chat-transcript-viewport-rect.ts";

export class ChatSessionVirtualizerHost implements ReactiveControllerHost, ChatTranscriptSession {
  private readonly renderer = new ChatTranscriptRenderer();
  private readonly offsetState = new TranscriptOffsetState();
  readonly entryAnimations = new ChatMessageEntryAnimations();
  expandedAssistantMessages = new Map<string, AssistantMessageExpansionState>();
  private readonly controllers = new Set<ReactiveController>();
  private readonly positionRail: PositionRailGutterController;
  private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  private readonly updateVirtualizer: () => void;
  private readonly viewportRect: TranscriptViewportRect;
  private readonly presentation: TranscriptPresentation;
  private threadInnerElement: HTMLDivElement | null = null;
  connected = false;
  private contentReady = false;
  // The in-flow history header's fixed height, folded into scrollMargin.
  // appliedHeaderHeight is what the current virtualizer margin already carries.
  private headerHeight = 0;
  private appliedHeaderHeight = 0;
  private implicitEndAnchorPending: boolean;
  private readonly endAnchor = new TranscriptEndAnchor();
  private readonly recordEndLayoutCorrection = (before: number, after: number) => {
    this.endAnchor.recordLayoutCorrection(before, after);
    this.scheduleEndReconcile();
  };
  readonly layout = new TranscriptLayoutOwner(this.recordEndLayoutCorrection);
  private readonly followEnd = () => this.scrollToEnd({ source: "auto", behavior: "auto" });
  private readonly reconcileEnd = () => {
    if (!this.connected || this.offsetState.pendingInteractionAnchor) {
      return;
    }
    this.commitComposerResize(true);
    this.endAnchor.reconcile(
      this.scrollElement,
      this.canAutoFollow(),
      this.offsetState.pendingScrollOffset !== null || this.offsetState.touchActive,
      this.followEnd,
    );
  };
  private readonly scrollRestoreHost: TranscriptScrollRestoreHost;
  private readonly messageReveal = new ChatMessageReveal();
  // The caller can insert this root after its first native commit. Resolve the
  // scroll parent lazily or a stable ref can permanently capture null.
  get scrollElement(): HTMLDivElement | null {
    const parent = this.threadInnerElement?.parentElement;
    return this.connected && parent instanceof HTMLDivElement && parent.isConnected ? parent : null;
  }
  // Keep one ref per root and row so redraws do not repeat attachment work.
  readonly scrollElementRef = (element?: Element) => {
    const next = element instanceof HTMLDivElement ? element : null;
    this.threadInnerElement = next;
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
      const instance = this.virtualizer;
      if (this.connected && instance.scrollElement !== this.scrollElement) {
        this.layout.connect(this.scrollElement);
        this.updateVirtualizer();
        this.host.requestUpdate();
      }
    });
  }
  private readonly rowRefs: TranscriptRowRefs;
  private readonly captureInteractionResize = (event: Event) => {
    const anchor = resolveChatTranscriptInteractionAnchor(event);
    if (!anchor) {
      return;
    }
    this.endAnchor.clear();
    this.prependAnchor.clear();
    this.offsetState.pendingInteractionAnchor = anchor;
    queueMicrotask(
      () => this.offsetState.pendingInteractionAnchor === anchor && this.host.requestUpdate(),
    );
  };
  private measureConnectedRows(): boolean {
    // Native input can land after takeover but before its offset observer.
    // Refresh the offset and direction before compensating deferred row growth.
    this.offsetState.syncNativeOffset?.();
    return measureConnectedTranscriptRows(this.scrollElement, this.virtualizer);
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
    this.viewportRect.recordMeasuredWidth(rect.width);
    this.measureConnectedRows();
  };
  private rowKeys: readonly string[] = [];
  private rowIndexesByKey = new Map<string, number>();
  private messageRowKeysById: ReadonlyMap<string, string> = new Map();
  private readonly prependAnchor = new TranscriptPrependAnchor();
  private candidateMessageRowKeysById: ReadonlyMap<string, string> = new Map();
  private candidateMessageRowsByKey: ReadonlyMap<string, string> = new Map();
  private renderPreviousRows: (() => HTMLDivElement) | null = null;
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
    this.viewportRect = new TranscriptViewportRect({
      getScrollElement: () => this.scrollElement,
      getHeaderHeight: () => this.appliedHeaderHeight,
      positionRail: this.positionRail,
      commitComposerResize: () => this.commitComposerResize(true),
      measureConnectedRows: () => this.measureConnectedRows(),
      queueRowMeasure: () => this.presentation.queueRowMeasure(),
      onViewportResize: () => this.callbacks.onViewportResize?.(),
      requestUpdate: () => this.host.requestUpdate(),
    });
    this.implicitEndAnchorPending = initialOffset === null;
    this.virtualizer = new Virtualizer({
      // Every geometry notification must commit before paint, including non-sync measurements.
      onChange: () => this.host.requestUpdate(),
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      getItemKey: () => "",
      initialRect: initialTranscriptRect(),
      initialOffset: initialOffset ?? Number.MAX_SAFE_INTEGER,
      anchorTo: "end",
      followOnAppend: false,
      scrollToFn: (offset, options, instance) =>
        scrollTranscriptOffset(this.offsetState, offset, options, instance),
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
            requestUpdate: () => this.host.requestUpdate(),
            onOffset: () => this.endAnchor.recordViewport(this.scrollElement),
            onComposerLayout: (changed) => this.commitComposerResize(changed),
            onReaderScroll: (towardEnd) => {
              this.implicitEndAnchorPending = false;
              this.callbacks.onReaderScroll?.(towardEnd);
            },
          },
          instance,
          callback,
        ),
      measureElement: measureTranscriptRow,
      rangeExtractor: (range) =>
        this.prependAnchor.extractRange(range, this.rowIndexesByKey, this.focusedRowKey),
      // Virtual distance omits real padding, pinning readers ~80px up past scroll.ts's follow-lock.
      // scheduleCommittedChatScroll owns end-follow on content changes and source: "resize".
      // Disable isAtEnd()'s default too; callers must supply an explicit threshold.
      scrollEndThreshold: -1,
      overscan: CHAT_TRANSCRIPT_OVERSCAN,
    });
    // Virtual-core exposes these lifecycle hooks as bound arrow functions.
    const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = this.virtualizer;
    this.updateVirtualizer = updateVirtualizer;
    let cleanupVirtualizer: (() => void) | undefined;
    this.addController({
      hostConnected: () => {
        cleanupVirtualizer = mountVirtualizer();
      },
      hostUpdated: this.updateVirtualizer,
      hostDisconnected: () => cleanupVirtualizer?.(),
    });
    this.presentation = new TranscriptPresentation(this, () => this.measureConnectedRows());
    this.rowRefs = new TranscriptRowRefs(this.virtualizer, {
      isCurrentRow: (element, key) =>
        this.threadInnerElement?.contains(element) === true && this.rowIndexesByKey.has(key),
      onMount: () => this.queueLayout(),
    });
    this.scrollRestoreHost = {
      offsetState: this.offsetState,
      virtualizer: this.virtualizer,
      getScrollElement: () => this.scrollElement,
      isContentReady: () => this.contentReady,
      getRowCount: () => this.rowKeys.length,
      isConnected: () => this.connected,
      pendingScrollFrame: null,
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
    this.renderer.connect();
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

  private scheduleEndReconcile(): void {
    if (this.connected) {
      this.endAnchor.scheduleReconcile(this.reconcileEnd);
    }
  }

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
    this.layout.connect(this.scrollElement);
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    const interactionResizePending = this.offsetState.pendingInteractionAnchor !== null;
    this.reconcileInteractionResize();
    if (
      !this.offsetState.touchActive &&
      this.prependAnchor.update(this.scrollElement, this.virtualizer, () =>
        this.measureConnectedRows(),
      )
    ) {
      this.offsetState.syncNativeOffset?.();
      this.host.requestUpdate();
    }
    applyPendingScrollOffset(this.scrollRestoreHost);
    this.queueLayout();
    // Disclosure measurement owns this commit; its sizer lands on the next update.
    if (interactionResizePending) {
      this.endAnchor.cancelReconcile();
    } else {
      this.scheduleEndReconcile();
    }
  };

  disconnect(): void {
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
    if (this.host instanceof HTMLElement) {
      this.host.removeEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    }
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }

  dispose(): void {
    this.disconnect();
    this.renderer.dispose();
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
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay: unknown = nothing,
    header: TranscriptHeader | null = null,
    presented: PresentationValue = true,
  ): HTMLDivElement {
    this.offsetState.renderedScrollState = this.offsetState.renderState(
      this.scrollElement !== null && this.endAnchor.atEnd,
    );
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
      : virtualizer.getVirtualItems().flatMap(({ index }) => rows[index]?.key ?? []);
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
        return this.renderer.render({
          layout: this.layout,
          headerHeight: this.headerHeight,
          presented: snapshot.presented,
          initialPositionPending: this.implicitEndAnchorPending,
          onCommit: () => this.connected && this.didCommit(),
          rows,
          getContent: (index) => (rows[index] ? renderRow(rows[index]) : nothing),
          virtualizer,
          overlay,
          header: header?.template ?? nothing,
          scrollElementRef: this.scrollElementRef,
          captureInteractionResize: this.captureInteractionResize,
          measureRowRefFor: (key) => this.rowRefs.forKey(key),
          measureRows:
            // The first correction reveals new rows; their real sizes must land before retiring the anchor.
            this.implicitEndAnchorPending ||
            this.prependAnchor.messageKey !== null ||
            this.offsetState.scrollCommand?.target === "message" ||
            this.offsetState.scrollCommand?.target === "index",
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
      {
        afterCommit: (effect) => {
          this.renderer.afterCommit(effect);
        },
      },
      // SAFETY: Both gate branches return this session's Solid root while MCP views retire.
    ) as HTMLDivElement;
  }

  get isMaintenanceScroll(): boolean {
    return (
      (this.endAnchor.isResizeAnchor(this.scrollElement) && this.canAutoFollow()) ||
      isTranscriptMaintenanceScroll(this.offsetState, this.scrollElement)
    );
  }

  get isProgrammaticScroll(): boolean {
    return isTranscriptProgrammaticScroll(this.offsetState, this.scrollElement);
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
      this.implicitEndAnchorPending = false;
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
    // Only smooth commands skip row measurements. Replaying ordinary auto
    // scrolling's overscan sizes can move an already settled end anchor.
    if (this.offsetState.scrollCommand?.behavior === "smooth") {
      this.presentation.queueRowMeasure();
    }
    this.offsetState.scrollCommand = null;
    this.offsetState.pendingScrollOffset = null;
    if (this.scrollRestoreHost.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.scrollRestoreHost.pendingScrollFrame);
      this.scrollRestoreHost.pendingScrollFrame = null;
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
    this.implicitEndAnchorPending = false;
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
    this.host.requestUpdate();
    this.queueLayout();
    return true;
  }

  private completeMessageReveal(): void {
    const command = this.offsetState.scrollCommand;
    if (command?.target !== "message") {
      return;
    }
    const virtualizer = this.virtualizer;
    if (this.messageReveal.reveal(this.threadInnerElement, command, virtualizer)) {
      this.offsetState.scrollCommand = { behavior: command.behavior, target: "index" };
      return;
    }
    // Expanding folded work can move the target beyond the initially mounted rows.
    const rowKey = this.messageRowKeysById.get(command.messageId);
    const rowIndex = rowKey ? this.rowIndexesByKey.get(rowKey) : undefined;
    if (rowIndex !== undefined) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
      this.host.requestUpdate();
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
    const virtualizer = this.virtualizer;
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

  private syncRows(nextKeys: readonly string[]): void {
    const virtualizer = this.virtualizer;
    this.rowKeys = Object.freeze(nextKeys);
    const rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    this.rowIndexesByKey = rowIndexesByKey;
    this.rowRefs.retainKeys(rowIndexesByKey);
    // The header margin must land in the same setOptions as the key change:
    // the edge-key re-anchor uses absolute offsets, so a prepend that also
    // removes the header (exhausted history) compensates in one adjustment.
    this.appliedHeaderHeight = this.headerHeight;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: nextKeys.length,
      getItemKey: (index) => nextKeys[index] ?? `missing:${index}`,
      rangeExtractor: (range) =>
        this.prependAnchor.extractRange(range, rowIndexesByKey, this.focusedRowKey),
      scrollMargin: resolveTranscriptScrollMargin(this.scrollElement, this.headerHeight),
    });
  }

  private queueLayout(): void {
    if (
      (this.implicitEndAnchorPending && this.rowKeys.length) ||
      this.offsetState.scrollCommand?.target === "message"
    ) {
      this.renderer.queueAfterLayout(this.completeLayout);
    }
  }

  private readonly completeLayout = () => {
    if (!this.connected) {
      return;
    }
    this.completeMessageReveal();
    if (
      !this.implicitEndAnchorPending ||
      !this.rowKeys.length ||
      !this.scrollElement?.clientHeight
    ) {
      return;
    }
    this.layout.sync();
    this.viewportRect.sync();
    if (this.measureConnectedRows()) {
      this.host.requestUpdate();
      return;
    }
    this.implicitEndAnchorPending = false;
    if (
      this.canAutoFollow() &&
      !this.offsetState.pendingInteractionAnchor &&
      !this.offsetState.touchActive
    ) {
      this.scrollToEnd({ source: "auto", behavior: "instant" });
      this.offsetState.syncNativeOffset?.();
    }
    this.host.requestUpdate();
  };
}
