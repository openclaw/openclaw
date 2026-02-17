import { describe, it, expect } from "vitest";
import { warnUnsafeNumericIds } from "./validation-numeric-ids.js";

describe("warnUnsafeNumericIds", () => {
  it("returns no warnings for safe integers", () => {
    const raw = { channels: { discord: { guilds: { test: { users: [123, "456"] } } } } };
    expect(warnUnsafeNumericIds(raw)).toEqual([]);
  });

  it("warns about numeric values exceeding MAX_SAFE_INTEGER", () => {
    // Simulate what JSON.parse does to large unquoted numbers
    const raw = JSON.parse(
      '{"channels":{"discord":{"guilds":{"s":{"users":[233734246190153728]}}}}}',
    );
    const warnings = warnUnsafeNumericIds(raw);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("channels.discord.guilds.s.users[0]");
    expect(warnings[0].message).toContain("MAX_SAFE_INTEGER");
    expect(warnings[0].message).toContain("quotes");
  });

  it("warns about multiple unsafe IDs", () => {
    const raw = JSON.parse('{"users":[233734246190153728, 804620549493620756]}');
    const warnings = warnUnsafeNumericIds(raw);
    expect(warnings).toHaveLength(2);
  });

  it("ignores strings, booleans, and null", () => {
    const raw = { a: "big number 99999999999999999", b: true, c: null };
    expect(warnUnsafeNumericIds(raw)).toEqual([]);
  });

  it("ignores NaN and Infinity", () => {
    const raw = { a: NaN, b: Infinity, c: -Infinity };
    expect(warnUnsafeNumericIds(raw)).toEqual([]);
  });

  it("handles deeply nested structures", () => {
    const raw = JSON.parse('{"a":{"b":{"c":{"d":233734246190153728}}}}');
    const warnings = warnUnsafeNumericIds(raw);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("a.b.c.d");
  });
});
