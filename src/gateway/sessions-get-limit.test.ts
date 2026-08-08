import { describe, expect, it } from "vitest";
import { resolveSessionsGetMessageLimit } from "./sessions-get-limit.js";

describe("resolveSessionsGetMessageLimit", () => {
  it("defaults missing or non-finite limits", () => {
    expect(resolveSessionsGetMessageLimit(undefined)).toBe(200);
    expect(resolveSessionsGetMessageLimit(Number.NaN)).toBe(200);
    expect(resolveSessionsGetMessageLimit("12")).toBe(200);
  });

  it("floors and keeps positive limits under the hard cap", () => {
    expect(resolveSessionsGetMessageLimit(1)).toBe(1);
    expect(resolveSessionsGetMessageLimit(12.9)).toBe(12);
    expect(resolveSessionsGetMessageLimit(1000)).toBe(1000);
  });

  it("caps oversized numeric limits before transcript reads", () => {
    expect(resolveSessionsGetMessageLimit(1001)).toBe(1000);
    expect(resolveSessionsGetMessageLimit(Number.MAX_SAFE_INTEGER)).toBe(1000);
  });
});
