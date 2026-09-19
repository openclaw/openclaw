import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { createTranscriptOffsetState } from "./chat-transcript-offset-observer.ts";

/** Geometric end anchoring; the pane still owns permission to follow. */
export class TranscriptEndAnchor {
  private offset: number | null = null;
  private followingBeforeCommit = false;
  private frame: number | null = null;

  get isCommitPending(): boolean {
    return this.followingBeforeCommit;
  }

  prepareUpdate(
    element: HTMLDivElement | null,
    canFollow: boolean,
    state: ReturnType<typeof createTranscriptOffsetState>,
  ): void {
    if (
      !this.followingBeforeCommit &&
      element &&
      canFollow &&
      !state.pendingScrollOffset &&
      (!state.scrollCommand || state.scrollCommand.target === "end") &&
      !state.pendingInteractionAnchor &&
      !state.touching &&
      !state.touchScrolling &&
      Math.abs((maxTranscriptScrollOffset(element) ?? 0) - element.scrollTop) <= 1
    ) {
      // Nested footer commits can temporarily enlarge the viewport and clamp
      // its offset before the final dock and measured rows reach the DOM.
      this.followingBeforeCommit = true;
    }
  }

  releaseCommit(): boolean {
    const following = this.followingBeforeCommit;
    this.followingBeforeCommit = false;
    return following;
  }

  scheduleReconcile(reconcile: (followingBeforeCommit: boolean) => void): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children still change layout after the pane's commit.
    // Coalesce end-follow after those commits using the current reader's anchor.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      reconcile(this.releaseCommit());
    });
  }

  cancelReconcile(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  clear(): void {
    this.offset = null;
    this.followingBeforeCommit = false;
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
    followingBeforeCommit = false,
  ): void {
    if (
      followingBeforeCommit &&
      canFollow &&
      element &&
      Math.abs((maxTranscriptScrollOffset(element) ?? 0) - element.scrollTop) > 1
    ) {
      follow();
    }
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
