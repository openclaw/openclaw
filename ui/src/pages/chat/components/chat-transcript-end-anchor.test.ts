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

  it.each([
    ["unchanged viewport", 600, 600, 400, true, 600, false],
    ["end", 600, 600, 300, true, 700, false],
    ["near end", 594, 594, 300, true, 700, false],
    ["reader", 200, 200, 300, true, 200, false],
    ["native return", 0, 600, 300, false, 700, true],
    ["ancestor displacement", 600, 572, 376, true, 624, false],
  ] as const)(
    "preserves composer resize intent after %s",
    (_, offset, before, height, canFollow, after, resumeFollow) => {
      const { element, anchor, commit, resize } = fixture(offset);
      const resized = vi.fn();
      const unsubscribe = subscribeTranscriptScroll(element, resized);
      try {
        if (resumeFollow) {
          element.scrollTop = before;
        }
        anchor.invalidateComposerResize(true);
        element.scrollTop = before;
        resize(height);
        expect(commit(true, canFollow)).toEqual({ before, after, resumeFollow });
        expect(element.scrollTop).toBe(after);
        if (height === 400) {
          expect(resized).not.toHaveBeenCalled();
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([true, false])(
    "preserves follow permission across shrink and regrowth: %s",
    (canFollow) => {
      const { element, anchor, commit, resize } = fixture(canFollow ? 600 : 550);
      anchor.invalidateComposerResize(canFollow);
      resize(500);
      element.scrollTop = 500;
      expect(commit(true, canFollow)).toEqual({
        before: canFollow ? 600 : 500,
        after: 500,
        resumeFollow: false,
      });
      if (!canFollow) {
        anchor.reconcile(element, false, false, vi.fn());
      }
      anchor.invalidateComposerResize(canFollow);
      resize(canFollow ? 450 : 400);
      expect(commit(true, canFollow)).toEqual({
        before: 500,
        after: canFollow ? 550 : 500,
        resumeFollow: false,
      });
    },
  );

  it("preserves a capped editor's end intent until late native ancestor scrolling settles", () => {
    const { element, anchor, commit, readHeight, readContent } = fixture();
    for (let index = 0; index < 10; index += 1) {
      anchor.invalidateComposerResize(true);
      expect(commit(false, true)).toBeNull();
    }
    expect(readHeight).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(600);
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
