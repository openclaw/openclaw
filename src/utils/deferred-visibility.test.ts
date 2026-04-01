import { describe, expect, it } from "vitest";
import {
  assertDeferredDisplayPayload,
  assertUserVisibleDeferredDisplayPayload,
  hasDeferredDisplayContent,
  isUserVisibleDeferredDisplayPayload,
} from "./deferred-visibility.js";

describe("deferred-visibility", () => {
  it("treats text or summaryLine as valid display content", () => {
    expect(hasDeferredDisplayContent({ visibility: "user-visible", text: "hello" })).toBe(true);
    expect(
      hasDeferredDisplayContent({ visibility: "summary-only", summaryLine: "queued item" }),
    ).toBe(true);
    expect(hasDeferredDisplayContent({ visibility: "user-visible", text: "   " })).toBe(false);
  });

  it("recognizes user-visible display payloads only when they have content", () => {
    expect(isUserVisibleDeferredDisplayPayload({ visibility: "user-visible", text: "ready" })).toBe(
      true,
    );
    expect(
      isUserVisibleDeferredDisplayPayload({ visibility: "summary-only", summaryLine: "later" }),
    ).toBe(false);
    expect(isUserVisibleDeferredDisplayPayload({ visibility: "user-visible", text: "   " })).toBe(
      false,
    );
  });

  it("rejects missing or non-display payload content", () => {
    expect(() => assertDeferredDisplayPayload(undefined)).toThrow(
      /Missing deferred display payload/,
    );
    expect(() =>
      assertDeferredDisplayPayload({ visibility: "summary-only", text: "  ", summaryLine: "" }),
    ).toThrow(/missing text or summaryLine/);
    expect(() =>
      assertDeferredDisplayPayload({
        visibility: "internal",
        agentPrompt: "hidden",
      } as never),
    ).toThrow(/expected display visibility/);
  });

  it("rejects non-user-visible payloads at the user-visible assertion boundary", () => {
    expect(() =>
      assertUserVisibleDeferredDisplayPayload({
        visibility: "summary-only",
        summaryLine: "queued summary",
      }),
    ).toThrow(/expected visibility=user-visible/);

    expect(
      assertUserVisibleDeferredDisplayPayload({ visibility: "user-visible", text: "safe" }).text,
    ).toBe("safe");
  });
});
