import { describe, expect, it } from "vitest";
import { readJsonPredicateScalar, scanJsonObjectFields } from "./json-predicate-fields.js";

describe("JSON predicate field scanning", () => {
  it("keeps NUL-terminated path labels separate from exact last-member keys", () => {
    const fields = scanJsonObjectFields('{"type\\u0000suffix":"message","type":"reset"}', ["type"]);
    expect(readJsonPredicateScalar(fields.first.get("type"))).toBe("message");
    expect(readJsonPredicateScalar(fields.last.get("type"))).toBe("reset");
  });

  it("preserves first and last members while skipping opaque containers and strings", () => {
    const fields = scanJsonObjectFields(
      '{"kind":"first","body":[{"kind":"nested","text":"}\\\""}],"ki\\u006ed":"last","count":1.0}',
      ["kind", "count"],
    );
    expect(fields.valid).toBe(true);
    expect(readJsonPredicateScalar(fields.first.get("kind"))).toBe("first");
    expect(readJsonPredicateScalar(fields.last.get("kind"))).toBe("last");
    expect(fields.first.get("count")).toEqual({ kind: "number", text: "1.0" });
  });

  it.each(["null", "[]", "{}", "1", "true", '"text"', "{}\0ignored"])(
    "accepts complete JSON %s",
    (json) => {
      expect(scanJsonObjectFields(json, ["kind"]).valid).toBe(true);
    },
  );

  it.each([
    '{"kind":}',
    '{"kind":"bad\nvalue"}',
    '{"kind":"\\x"}',
    "[1,]",
    "{,}",
    "01",
    "{} trailing",
  ])("rejects malformed JSON %s", (json) => {
    const fields = scanJsonObjectFields(json, ["kind"]);
    expect(fields.valid).toBe(false);
    expect(fields.first.size).toBe(0);
  });

  it("records SQLite's container-depth boundary for empty and scalar leaves", () => {
    for (const count of [999, 1000, 1001]) {
      expect(
        scanJsonObjectFields("[".repeat(count) + "0" + "]".repeat(count), []).maximumDepth,
      ).toBe(count);
      expect(scanJsonObjectFields("[".repeat(count) + "]".repeat(count), []).maximumDepth).toBe(
        count,
      );
    }
  });
});
