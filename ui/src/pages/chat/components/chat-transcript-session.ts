// Render contract between the transcript projection and the per-session
// virtualizer host owned by ChatTranscriptController.
import type { ReactiveController, ReactiveControllerHost, TemplateResult } from "lit";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import type { ChatSessionScrollPosition } from "../scroll.ts";
import type { ChatMessageEntryAnimations } from "./chat-message-entry.ts";
import type { TranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

/** A reader-position restoration that is waiting for measurable transcript geometry. */
export type ChatTranscriptPendingScrollOffset = {
  offset: number;
  observedMaxOffset?: number;
  stableFrames: number;
  zeroMaxFrames: number;
  onSettled?: (position: ChatSessionScrollPosition) => void;
};

export type TranscriptCallbacks = {
  onViewportResize?: () => void;
  onReaderScroll?: (towardEnd?: boolean) => void;
  /** The pane owns reader intent; geometry-only follow must honor that policy. */
  canFollowEnd?: () => boolean;
};

export const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
export const CHAT_TRANSCRIPT_OVERSCAN = 6;
// Initial virtual rows can correct their estimates for several frames. Observe
// the range for ~200ms before accepting a saved offset that remains unreachable.
export const CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES = 12;
// A committed short transcript can legitimately remain at maxOffset=0. Give
// initial measurement one second before treating that zero range as final.
export const CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES = 60;

export type TranscriptHeader = {
  template: unknown;
  /** Fixed pixel height; becomes the virtualizer's scrollMargin so row offsets stay exact. */
  height: number;
};

export type ChatTranscriptSession = {
  readonly layout: Pick<TranscriptLayoutOwner, "viewportResizePending">;
  readonly entryAnimations: ChatMessageEntryAnimations;
  readonly expandedAssistantMessages: Map<string, AssistantMessageExpansionState>;
  readonly liveAnnouncementText: string;
  readonly scrollElementRef: (element?: Element) => void;
  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay?: unknown,
    header?: TranscriptHeader | null,
  ): TemplateResult;
  syncMessageRows(
    messageRowKeysById: ReadonlyMap<string, string>,
    messageRowsByKey: ReadonlyMap<string, string>,
  ): void;
  /** Returns the sampled loaded message at or preceding the viewport midpoint. */
  activeMessageId(messageIds: readonly string[]): string | null;
  revealMessage(messageId: string): boolean;
  setContentReady(ready: boolean): void;
  handleFocusIn(event: FocusEvent): void;
  handleFocusOut(event: FocusEvent): void;
};

/** Rows and lookup identities that must be promoted as one rendered projection. */
export type TranscriptRenderSnapshot<T> = {
  rows: readonly TranscriptRow<T>[];
  renderRow: (row: TranscriptRow<T>) => unknown;
  announcement: TranscriptAnnouncement | null;
  announce: boolean;
  overlay: unknown;
  header: TranscriptHeader | null;
  messageRows: ReadonlyMap<string, string>;
  renderKeyRows: ReadonlyMap<string, string>;
  entryKeys: ChatMessageEntryAnimations["projectedKeys"];
};

/** Session-owned deferred measurements after width changes and smooth scrolling. */
export class TranscriptPresentation implements ReactiveController {
  private measureFrame: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly scrollElement: HTMLDivElement | null;
    },
    private readonly measureConnectedRows: () => boolean,
  ) {
    host.addController(this);
  }

  queueRowMeasure(): void {
    if (this.measureFrame !== null) {
      return;
    }
    const element = this.host.scrollElement;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = null;
      if (element === this.host.scrollElement) {
        this.measureConnectedRows();
      }
    });
  }

  hostDisconnected(): void {
    if (this.measureFrame !== null) {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
  }
}
