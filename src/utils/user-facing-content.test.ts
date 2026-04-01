import { describe, expect, it } from "vitest";

import { toUserFacingContent } from "./user-facing-content.js";

describe("user-facing-content", () => {
  it("converts explicit user-visible deferred payloads into user-facing content", () => {
    expect(
      toUserFacingContent({
        payload: { visibility: "user-visible", text: "hello" },
        source: "queued-followup-display",
      }),
    ).toEqual({
      visibility: "user-visible",
      text: "hello",
      summaryLine: undefined,
      source: "queued-followup-display",
    });
  });

  it("rejects non-user-visible deferred payloads", () => {
    expect(() =>
      toUserFacingContent({
        payload: { visibility: "summary-only", summaryLine: "summary" },
        source: "summary-renderer",
      }),
    ).toThrow(/expected visibility=user-visible/);
  });
});
