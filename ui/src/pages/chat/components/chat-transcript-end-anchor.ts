import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { createTranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";

/** Geometric end anchoring; the pane still owns permission to follow. */
export class TranscriptEndAnchor {
  private offset: number | null = null;
  private followingBeforeCommit = false;
  private offsetBeforeUpdate: number | null = null;
  private frame: number | null = null;

  isResizingCommit(element: HTMLDivElement | null): boolean {
    const max = maxTranscriptScrollOffset(element);
    return (
      this.followingBeforeCommit &&
      this.offset !== null &&
      max !== null &&
      element !== null &&
      Math.abs(element.scrollTop - this.offset) <= 1 &&
      this.offset !== max
    );
  }

  prepareUpdate(
    element: HTMLDivElement | null,
    canFollow: boolean,
    state: ReturnType<typeof createTranscriptOffsetState>,
  ): void {
    // A prior commit may still await its frame when native scrolling starts.
    // Only offsets recorded inside that commit can extend its end ownership.
    if (element && this.offset !== null && Math.abs(element.scrollTop - this.offset) > 1) {
      this.clear();
    }
    if (
      !this.followingBeforeCommit &&
      element &&
      canFollow &&
      this.offset !== null &&
      Math.abs(this.offset - element.scrollTop) <= 1 &&
      !state.pendingScrollOffset &&
      (!state.scrollCommand || state.scrollCommand.target === "end") &&
      !state.pendingInteractionAnchor &&
      !state.touching &&
      !state.touchScrolling &&
      Math.abs((maxTranscriptScrollOffset(element) ?? 0) - element.scrollTop) <= 1
    ) {
      // Only extend an observed end anchor. Physical end geometry alone can
      // come from a native clamp or persist just after reader input cancelled follow.
      // Nested footer commits can temporarily enlarge the viewport and clamp
      // its offset before the final dock and measured rows reach the DOM.
      this.followingBeforeCommit = true;
    }
    this.offsetBeforeUpdate = this.followingBeforeCommit ? (element?.scrollTop ?? null) : null;
  }

  commitUpdate(element: HTMLDivElement | null): void {
    // Lit's synchronous pre/post-update hooks bracket the DOM commit. An offset
    // changed within those hooks is its layout clamp, not a later reader task.
    if (
      this.followingBeforeCommit &&
      element &&
      this.offsetBeforeUpdate !== null &&
      element.scrollTop !== this.offsetBeforeUpdate
    ) {
      this.offset = element.scrollTop;
    }
    this.offsetBeforeUpdate = null;
  }

  releaseCommit(): void {
    this.followingBeforeCommit = false;
    this.offsetBeforeUpdate = null;
  }

  scheduleReconcile(reconcile: () => void): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children still change layout after the pane's commit.
    // Coalesce end-follow after those commits using the current reader's anchor.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.releaseCommit();
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
    this.releaseCommit();
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
    if (!this.composerResizePending) {
      return null;
    }
    if (!changed || suspended) {
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

  clear(): void {
    this.cancelComposerResize();
    this.offset = null;
    this.followingBeforeCommit = false;
    this.offsetBeforeUpdate = null;
  }

  capture(element: HTMLDivElement | null): void {
    const max = maxTranscriptScrollOffset(element);
    this.maxOffset = max;
    this.lastOffset = element?.scrollTop ?? null;
    this.offset = element && max !== null && Math.abs(max - element.scrollTop) <= 1 ? max : null;
  }

  reconcile(
    element: HTMLDivElement | null,
    canFollow: boolean,
    suspended: boolean,
    follow: () => void,
  ): void {
    const max = maxTranscriptScrollOffset(element);
    this.maxOffset = max;
    this.lastOffset = element?.scrollTop ?? null;
    // A resized viewport can clamp a reader to the end without granting follow.
    if (!canFollow) {
      this.clear();
      return;
    }
    if (suspended) {
      return;
    }
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
