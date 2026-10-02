/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

describe("native composer end anchoring", () => {
  function fixture(offset = 600) {
    const element = document.createElement("div");
    let height = 400;
    const readHeight = vi.fn(() => height);
    const readContent = vi.fn(() => 1000);
    Object.defineProperties(element, {
      clientHeight: { get: readHeight },
      scrollHeight: { get: readContent },
    });
    element.scrollTop = offset;
    const anchor = new TranscriptEndAnchor();
    anchor.reconcile(element, false, false, vi.fn());
    const commit = (changed: boolean, canFollow: boolean) =>
      anchor.commitComposerResize(element, changed, canFollow, false);
    readHeight.mockClear();
    readContent.mockClear();
    return {
      element,
      anchor,
      commit,
      readHeight,
      readContent,
      resize: (next: number) => (height = next),
    };
  }

  it("does not measure the transcript for native edits that keep the editor height", () => {
    const { element, anchor, commit, readHeight, readContent } = fixture();
    for (let index = 0; index < 10; index += 1) {
      anchor.invalidateComposerResize(true);
      expect(commit(false, true)).toBeNull();
    }
    expect(readHeight).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(600);
  });

  it("does not publish an unchanged viewport when a structural commit settles a native edit", () => {
    const { element, anchor, commit } = fixture();
    const resized = vi.fn();
    const unsubscribe = subscribeTranscriptScroll(element, resized);
    try {
      anchor.invalidateComposerResize(true);
      expect(commit(true, true)).toEqual({ before: 600, after: 600, resumeFollow: false });
      expect(resized).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([600, 594, 200])("preserves end versus reader position at %ipx", (offset) => {
    const { element, anchor, commit, resize } = fixture(offset);
    anchor.invalidateComposerResize(true);
    resize(300);
    const after = offset >= 592 ? 700 : offset;
    expect(commit(true, true)).toEqual({
      before: offset,
      after,
      resumeFollow: false,
    });
    expect(element.scrollTop).toBe(after);
  });

  it("recognizes a native return to the old end before its scroll event arrives", () => {
    const { element, anchor, commit, resize } = fixture(0);
    element.scrollTop = 600;
    anchor.invalidateComposerResize(true);
    resize(300);
    expect(commit(true, false)).toEqual({
      before: 600,
      after: 700,
      resumeFollow: true,
    });
  });

  it("commits a clamped shrink before a structural transition grows the viewport again", () => {
    const { element, anchor, commit, resize } = fixture();
    anchor.invalidateComposerResize(true);
    resize(500);
    element.scrollTop = 500;
    expect(commit(true, true)).toEqual({
      before: 600,
      after: 500,
      resumeFollow: false,
    });
    anchor.invalidateComposerResize(true);
    resize(450);
    expect(commit(true, true)).toEqual({
      before: 500,
      after: 550,
      resumeFollow: false,
    });
  });

  it("does not promote a reader clamped by shrink into following on later growth", () => {
    const { element, anchor, commit, resize } = fixture(550);
    anchor.invalidateComposerResize(false);
    resize(500);
    element.scrollTop = 500;
    expect(commit(true, false)).toEqual({
      before: 500,
      after: 500,
      resumeFollow: false,
    });
    anchor.reconcile(element, false, false, vi.fn());
    anchor.invalidateComposerResize(false);
    resize(400);
    expect(commit(true, false)).toEqual({
      before: 500,
      after: 500,
      resumeFollow: false,
    });
  });

  it("retains committed end intent when native editing scrolls an ancestor", () => {
    const { element, anchor, commit, resize } = fixture();
    anchor.invalidateComposerResize(true);
    element.scrollTop = 572;
    resize(376);
    expect(commit(true, true)).toEqual({
      before: 572,
      after: 624,
      resumeFollow: false,
    });
  });

  it("preserves a capped editor's end intent until late native ancestor scrolling settles", () => {
    const { element, anchor, commit, readContent } = fixture();
    anchor.invalidateComposerResize(true);
    expect(commit(false, true)).toBeNull();
    expect(readContent).not.toHaveBeenCalled();
    element.scrollTop = 500;
    expect(commit(true, true)).toEqual({
      before: 500,
      after: 600,
      resumeFollow: false,
    });
  });

  it("retires pending maintenance when the reader takes over", () => {
    const { element, anchor, commit, resize, readContent } = fixture();
    anchor.invalidateComposerResize(true);
    anchor.cancelComposerResize();
    resize(300);
    element.scrollTop = 200;
    expect(commit(true, true)).toBeNull();
    expect(readContent).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(200);
  });
});
