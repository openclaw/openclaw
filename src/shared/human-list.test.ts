import { describe, expect, it } from "vitest";
import { formatHumanList } from "./human-list.js";

describe("formatHumanList", () => {
  it.each([
    { values: [], expected: "" },
    { values: ["apple"], expected: "apple" },
    { values: ["apple", "banana"], expected: "apple or banana" },
    { values: ["apple", "banana", "cherry"], expected: "apple, banana, or cherry" },
  ])("formats $values", ({ values, expected }) => {
    expect(formatHumanList(values)).toBe(expected);
  });
});
