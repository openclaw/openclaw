import { describe, expect, it } from "vitest";
import { buildAllowlistResolutionSummary } from "./resolve-utils.js";

describe("buildAllowlistResolutionSummary", () => {
  it("returns mapping, additions, and unresolved (including missing ids)", () => {
    const resolvedUsers = [
      { input: "a", resolved: true, id: "1" },
      { input: "b", resolved: false },
      { input: "c", resolved: true },
    ];
    const result = buildAllowlistResolutionSummary(resolvedUsers);
    expect(result.mapping).toEqual(["a→1"]);
    expect(result.additions).toEqual(["1"]);
    expect(result.unresolved).toEqual(["b", "c"]);
  });

  it("supports custom resolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: true, id: "1", note: "x" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatResolved: (entry) =>
        `${entry.input}→${entry.id}${(entry as { note?: string }).note ? " (note)" : ""}`,
    });
    expect(result.mapping).toEqual(["a→1 (note)"]);
  });
});
