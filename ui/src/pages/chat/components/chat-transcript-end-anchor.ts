import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { createTranscriptOffsetState } from "./chat-transcript-offset-observer.ts";

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
    this.releaseCommit();
    this.cancelReconcile();
  }

  clear(): void {
    this.offset = null;
    this.followingBeforeCommit = false;
    this.offsetBeforeUpdate = null;
  }

  capture(element: HTMLDivElement | null): void {
    const max = maxTranscriptScrollOffset(element);
    this.offset = element && max !== null && Math.abs(max - element.scrollTop) <= 1 ? max : null;
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
