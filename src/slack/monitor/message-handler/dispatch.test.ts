import { describe, expect, it } from "vitest";
import { isSlackDraftPreviewEnabled } from "./dispatch.js";

describe("isSlackDraftPreviewEnabled", () => {
  it("returns false when slack preview streaming is off", () => {
    expect(
      isSlackDraftPreviewEnabled({
        mode: "off",
        blockStreaming: true,
      }),
    ).toBe(false);
  });

  it("returns false when block streaming is explicitly disabled", () => {
    expect(
      isSlackDraftPreviewEnabled({
        mode: "partial",
        blockStreaming: false,
      }),
    ).toBe(false);
  });

  it("keeps preview enabled when streaming is available and block streaming is allowed", () => {
    expect(
      isSlackDraftPreviewEnabled({
        mode: "partial",
        blockStreaming: true,
      }),
    ).toBe(true);
    expect(
      isSlackDraftPreviewEnabled({
        mode: "progress",
        blockStreaming: undefined,
      }),
    ).toBe(true);
  });
});
