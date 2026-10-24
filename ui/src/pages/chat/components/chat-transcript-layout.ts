import type { JSX } from "@solidjs/web";
import type { Virtualizer } from "@tanstack/virtual-core";
import type { ApplicationContext } from "../../../app/context.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import type { ChatHistoryBoundaryProps } from "./chat-history-boundary.tsx";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import type { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";

export type TranscriptContent = GuardedTranscriptItem | JSX.Element;

export type TranscriptRow<T = unknown> =
  | { kind: "item"; key: string; item: T }
  | { kind: "content"; key: string; content: TranscriptContent };

export type TranscriptLayoutProps = {
  applicationContext?: ApplicationContext;
  messageElements: TranscriptMessageElements;
  rows: readonly TranscriptRow[];
  getContent: (index: number) => TranscriptContent;
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  overlay: JSX.Element;
  header: ChatHistoryBoundaryProps | null;
  scrollElementRef: (element?: Element) => void;
  captureInteractionResize: (event: Event) => void;
  measureRowRefFor: (key: string) => (element?: Element) => void;
  measureRows: boolean;
  initialPositionPending: () => boolean;
  layout: TranscriptLayoutOwner;
  headerHeight: number;
  presented: PresentationValue;
  onCommit: () => void;
};
