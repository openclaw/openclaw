import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";

/** Geometric end anchoring; the pane still owns permission to follow. */
export class TranscriptEndAnchor {
  private offset: number | null = null;

  clear(): void {
    this.offset = null;
  }

  capture(element: HTMLDivElement | null): void {
    this.offset = maxTranscriptScrollOffset(element);
  }

  reconcile(
    element: HTMLDivElement | null,
    canFollow: boolean,
    suspended: boolean,
    follow: () => void,
  ): void {
    // A resized viewport can clamp a reader to the end without granting follow.
    if (!canFollow) {
      this.clear();
      return;
    }
    if (suspended) {
      return;
    }
    const max = maxTranscriptScrollOffset(element);
    if (!element || max === null) {
      return;
    }
    if (Math.abs(max - element.scrollTop) <= 1) {
      this.offset = max;
      return;
    }
    if (this.offset === null) {
      return;
    }
    if (Math.abs(element.scrollTop - this.offset) > 1) {
      this.clear();
      return;
    }
    // Row measurement moved the end while the reader still rests at its old edge.
    follow();
  }
}
