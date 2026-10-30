// Render contract between the transcript projection and the per-session
// virtualizer host owned by the chat transcript owner.
import type { JSX } from "@solidjs/web";
import type { Virtualizer } from "@tanstack/virtual-core";
import type { ApplicationContext } from "../../../app/context.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import type { ChatSessionScrollPosition } from "../scroll.ts";
import type { ChatMessageEntryAnimations } from "./chat-message-entry.ts";
import type { TranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import { readConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import type {
  ComposerActivityLayout,
  TranscriptLayoutOwner,
} from "./chat-transcript-layout-owner.ts";
import type { TranscriptContent, TranscriptRow } from "./chat-transcript-layout.ts";
import type { TranscriptMessageElements } from "./chat-transcript-message-elements.ts";

/** A reader-position restoration that is waiting for measurable transcript geometry. */
export type ChatTranscriptPendingScrollOffset = {
  offset: number;
  observedMaxOffset?: number;
  stableFrames: number;
  zeroMaxFrames: number;
  onSettled?: (position: ChatSessionScrollPosition) => void;
};

export type TranscriptCallbacks = {
  /** Sidebar commits originate on the pane element, separate from its state owner. */
  geometryEventTarget?: HTMLElement;
  getComposerFloat?: () => HTMLElement | null;
  getComposerActivityLayout?: () => ComposerActivityLayout | null;
  onViewportResize?: () => void;
  onReaderScroll?: (towardEnd?: boolean) => void;
  /** The pane owns reader intent; geometry-only follow must honor that policy. */
  canFollowEnd?: () => boolean;
};

export const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
export const CHAT_TRANSCRIPT_OVERSCAN = 2;
// Initial virtual rows can correct their estimates for several frames. Observe
// the range for ~200ms before accepting a saved offset that remains unreachable.
export const CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES = 12;
// A committed short transcript can legitimately remain at maxOffset=0. Give
// initial measurement one second before treating that zero range as final.
export const CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES = 60;

export type TranscriptHeader = {
  content: JSX.Element;
  /** Fixed pixel height; becomes the virtualizer's scrollMargin so row offsets stay exact. */
  height: number;
};

export type ChatTranscriptSession = {
  readonly layout: Pick<TranscriptLayoutOwner, "viewportResizePending" | "configureRows" | "ready">;
  readonly entryAnimations: ChatMessageEntryAnimations;
  readonly messageElements: TranscriptMessageElements;
  readonly contentElement: HTMLDivElement | null;
  readonly expandedAssistantMessages: Map<string, AssistantMessageExpansionState>;
  readonly liveAnnouncementText: string;
  readonly scrollElementRef: (element?: Element) => void;
  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => TranscriptContent,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay?: JSX.Element,
    header?: TranscriptHeader | null,
    presented?: PresentationValue,
    applicationContext?: ApplicationContext,
  ): HTMLDivElement;
  syncMessageRows(
    messageRowKeysById: ReadonlyMap<string, string>,
    messageRowsByKey: ReadonlyMap<string, string>,
  ): void;
  /** Returns the sampled loaded message at or preceding the viewport midpoint. */
  activeMessageId(messageIds: readonly string[]): string | null;
  revealMessage(messageId: string): boolean;
  handleFocusIn(event: FocusEvent): void;
  handleFocusOut(event: FocusEvent): void;
};

/** Rows and lookup identities that must be promoted as one rendered projection. */
export type TranscriptRenderSnapshot<T> = {
  rows: readonly TranscriptRow<T>[];
  renderRow: (row: TranscriptRow<T>) => TranscriptContent;
  announcement: TranscriptAnnouncement | null;
  announce: boolean;
  overlay: JSX.Element;
  header: TranscriptHeader | null;
  messageRows: ReadonlyMap<string, string>;
  renderKeyRows: ReadonlyMap<string, string>;
  entryKeys: ChatMessageEntryAnimations["projectedKeys"];
  presented: PresentationValue;
  applicationContext?: ApplicationContext;
};

/** Session-owned deferred measurements after width changes and smooth scrolling. */
export function createTranscriptPresentation(
  scrollElement: () => HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  rowElements: () => Iterable<HTMLElement>,
  beforeMeasure: () => void,
) {
  const readConnectedRows = (): (() => boolean) | null => {
    const apply = readConnectedTranscriptRows(scrollElement(), virtualizer, rowElements());
    return apply
      ? () => {
          beforeMeasure();
          return apply();
        }
      : null;
  };

  const presentation = {
    measureRows: () => readConnectedRows()?.() ?? false,
    measureRowsWithoutScrollAdjustment() {
      const adjustScroll = virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
      try {
        return presentation.measureRows();
      } finally {
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjustScroll;
      }
    },
    queueRowMeasure() {
      const element = scrollElement();
      scheduleLayout(presentation, () =>
        element === scrollElement() ? (readConnectedRows() ?? undefined) : undefined,
      );
    },
    disconnect: () => cancelLayout(presentation),
  };
  return presentation;
}
