import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";

/** Geometric end anchoring; the pane still owns permission to follow. */
export class TranscriptEndAnchor {
  private offset: number | null = null;
  private frame: number | null = null;

  isResizeAnchor(element: HTMLDivElement | null): boolean {
    const max = maxTranscriptScrollOffset(element);
    return (
      this.offset !== null &&
      max !== null &&
      element !== null &&
      Math.abs(element.scrollTop - this.offset) <= 1 &&
      this.offset !== max
    );
  }

  recordLayoutCorrection(before: number, after: number): void {
    if (this.offset !== null && Math.abs(this.offset - before) <= 1) {
      this.offset = after;
    } else {
      this.clear();
    }
  }

  scheduleReconcile(reconcile: () => void): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children still change layout after the pane's commit.
    // Coalesce end-follow after those commits using the current reader's anchor.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      reconcile();
    });
  }

  cancelReconcile(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  disconnect(): void {
    this.cancelComposerResize();
    this.cancelReconcile();
  }

  private maxOffset: number | null = null;
  private lastOffset: number | null = null;
  private composerResizePending: { preserveEnd: boolean } | null = null;

  invalidateComposerResize(canFollow: boolean): void {
    this.composerResizePending ??= {
      preserveEnd:
        canFollow &&
        this.maxOffset !== null &&
        this.lastOffset !== null &&
        this.maxOffset - this.lastOffset <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
    };
  }

  commitComposerResize(
    element: HTMLDivElement | null,
    changed: boolean,
    canFollow: boolean,
    suspended: boolean,
  ) {
    if (!this.composerResizePending || !changed || suspended) {
      // At the height cap, native caret scrolling can move the transcript
      // after overflow settles without producing a viewport ResizeObserver.
      return null;
    }
    const { preserveEnd } = this.composerResizePending;
    this.composerResizePending = null;
    const previousMax = this.maxOffset;
    const previousOffset = this.lastOffset;
    const max = maxTranscriptScrollOffset(element);
    if (!element || max === null) {
      return null;
    }
    const before = element.scrollTop;
    // Use the last committed geometry, not the already-grown scrollport. A
    // native return to its old end can precede the offset observer in this frame.
    const atPreviousEnd =
      previousMax !== null &&
      Math.abs(before - Math.min(previousMax, max)) <= CHAT_TRANSCRIPT_END_THRESHOLD_PX;
    // A shrink can clamp a reader to the end without permission to follow.
    // Only fresh movement toward the old end can supersede that reader policy.
    const resumeFollow =
      !canFollow && atPreviousEnd && this.lastOffset !== null && before > this.lastOffset;
    if (preserveEnd || (atPreviousEnd && (canFollow || resumeFollow))) {
      element.scrollTop = max;
      // A following structural commit must inherit this corrected edge, not
      // mistake the native editor displacement for reader movement.
      this.offset = element.scrollTop;
    }
    this.maxOffset = max;
    this.lastOffset = element.scrollTop;
    // Native layout can already have clamped the old end before observers run.
    // Publish that real displacement before a following goal/header commit
    // hides the intermediate viewport; otherwise its late scroll looks manual.
    const beforeResize =
      preserveEnd && previousOffset !== null && previousOffset > max && before === max
        ? previousOffset
        : before;
    const correction = { before: beforeResize, after: element.scrollTop, resumeFollow };
    if (previousMax !== max || correction.before !== correction.after) {
      publishTranscriptScroll(element, {
        type: "resize",
        viewport: {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: correction.after,
        },
        ...(correction.before !== correction.after
          ? { scrollCorrection: { before: correction.before, after: correction.after } }
          : {}),
      });
    }
    return correction;
  }

  cancelComposerResize(): void {
    this.composerResizePending = null;
  }

  get atEnd(): boolean {
    return (
      this.maxOffset !== null &&
      this.lastOffset !== null &&
      Math.abs(this.maxOffset - this.lastOffset) <= 1
    );
  }

  recordViewport(element: HTMLDivElement | null): boolean {
    // Native offsets must stay current even when no pane commit is needed.
    // Composer resize uses the prior offset to distinguish a return from a clamp.
    this.maxOffset = maxTranscriptScrollOffset(element);
    this.lastOffset = element?.scrollTop ?? null;
    return this.atEnd;
  }

  clear(): void {
    this.cancelComposerResize();
    this.offset = null;
  }

  capture(element: HTMLDivElement | null): void {
    this.offset = this.recordViewport(element) ? this.maxOffset : null;
  }

  reconcile(
    element: HTMLDivElement | null,
    canFollow: boolean,
    suspended: boolean,
    follow: () => void,
  ): void {
    const atEnd = this.recordViewport(element);
    // A resized viewport can clamp a reader to the end without granting follow.
    if (!canFollow) {
      this.clear();
      return;
    }
    if (suspended || !element || this.maxOffset === null || this.offset === null) {
      return;
    }
    if (atEnd) {
      this.offset = this.maxOffset;
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
