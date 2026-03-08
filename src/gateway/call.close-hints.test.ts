import { describe, expect, it } from "vitest";
import { resolveCloseReasonHint } from "./call.js";

describe("resolveCloseReasonHint", () => {
  it("returns pairing hint for 'pairing required'", () => {
    const hint = resolveCloseReasonHint("pairing required");
    expect(hint).toContain("openclaw devices approve");
  });

  it("returns doctor hint for 'device token mismatch'", () => {
    const hint = resolveCloseReasonHint(
      "unauthorized: device token mismatch (rotate/reissue device token)",
    );
    expect(hint).toContain("openclaw doctor");
  });

  it("returns auth hint for generic unauthorized", () => {
    const hint = resolveCloseReasonHint("unauthorized");
    expect(hint).toContain("gateway.auth.token");
  });

  it("returns undefined for unrecognized reasons", () => {
    expect(resolveCloseReasonHint("something else")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveCloseReasonHint("")).toBeUndefined();
  });
});
