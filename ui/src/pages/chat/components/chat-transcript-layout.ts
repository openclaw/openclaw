import type { Virtualizer } from "@tanstack/virtual-core";
import type { PresentationValue } from "../../../lit/presentation-binding.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";

export type TranscriptRow<T = unknown> =
  | { kind: "item"; key: string; item: T }
  | { kind: "content"; key: string; content: unknown };

export type TranscriptLayoutProps = {
  rows: readonly TranscriptRow[];
  getContent: (index: number) => unknown;
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  overlay: unknown;
  header: unknown;
  scrollElementRef: (element?: Element) => void;
  captureInteractionResize: (event: Event) => void;
  measureRowRefFor: (key: string) => (element?: Element) => void;
  measureRows: boolean;
  initialPositionPending: boolean;
  layout: TranscriptLayoutOwner;
  headerHeight: number;
  presented: PresentationValue;
  onCommit: () => void;
};
