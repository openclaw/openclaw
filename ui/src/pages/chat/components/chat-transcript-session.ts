// Render contract between the transcript projection and the per-session
// virtualizer host owned by ChatTranscriptController.
import type { TemplateResult } from "lit";
import type { AssistantMessageExpansionState } from "../chat-thread.ts";
import type { ChatSessionScrollPosition } from "../scroll.ts";
import type { TranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

/** A reader-position restoration that is waiting for stable transcript geometry. */
export type ChatTranscriptPendingScrollOffset = {
  offset: number;
  stableFrames: number;
  zeroMaxFrames: number;
  onSettled?: (position: ChatSessionScrollPosition) => void;
};

export type TranscriptCallbacks = {
  onViewportResize?: () => void;
  onReaderScroll?: () => void;
};

export const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
export const CHAT_TRANSCRIPT_OVERSCAN = 6;
// Initial virtual rows can correct their estimates for several frames. Hold a
// restored offset for ~200ms so those corrections cannot reapply the end anchor.
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

/** Presentation contract produced by the chat-item projection. */
export type ChatTranscriptProjection = {
  positionMessages: readonly unknown[];
  isDirectThread: boolean;
  isEmpty: boolean;
  showLoadingSkeleton: boolean;
  searchOpen: boolean;
  renderRows: (overlay?: unknown, header?: TranscriptHeader | null) => TemplateResult;
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
};
