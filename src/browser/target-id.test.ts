import { describe, expect, it } from "vitest";
import { resolveTargetIdFromTabs } from "./target-id.js";

describe("browser target id resolution", () => {
  it("resolves exact ids", () => {
    const res = resolveTargetIdFromTabs("FULL", [{ targetId: "AAA" }, { targetId: "FULL" }]);
    expect(res).toEqual({ ok: true, targetId: "FULL" });
  });

  it("resolves unique prefixes (case-insensitive)", () => {
    const res = resolveTargetIdFromTabs("57a01309", [
      { targetId: "57A01309E14B5DEE0FB41F908515A2FC" },
    ]);
    expect(res).toEqual({
      ok: true,
      targetId: "57A01309E14B5DEE0FB41F908515A2FC",
    });
  });

  it("fails on ambiguous prefixes", () => {
    const res = resolveTargetIdFromTabs("57A0", [
      { targetId: "57A01309E14B5DEE0FB41F908515A2FC" },
      { targetId: "57A0BEEF000000000000000000000000" },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ambiguous");
      expect(res.matches?.length).toBe(2);
    }
  });

  it("fails when no tab matches", () => {
    const res = resolveTargetIdFromTabs("NOPE", [{ targetId: "AAA" }]);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
