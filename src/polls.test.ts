import { describe, expect, it } from "vitest";
import {
  normalizePollDurationHours,
  normalizePollInput,
  resolvePollMaxSelections,
} from "./polls.js";

describe("polls", () => {
  it("normalizes question/options and validates maxSelections", () => {
    expect(
      normalizePollInput({
        question: "  Lunch? ",
        options: [" Pizza ", " ", "Sushi"],
        maxSelections: 2,
      }),
    ).toEqual({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 2,
      durationSeconds: undefined,
      durationHours: undefined,
    });
  });

  it("enforces max option count when configured", () => {
    expect(() =>
      normalizePollInput({ question: "Q", options: ["A", "B", "C"] }, { maxOptions: 2 }),
    ).toThrow(/at most 2/);
  });

  it.each([
    { durationHours: undefined, expected: 24 },
    { durationHours: 999, expected: 48 },
    { durationHours: 1, expected: 1 },
  ])("clamps poll duration for $durationHours hours", ({ durationHours, expected }) => {
    expect(normalizePollDurationHours(durationHours, { defaultHours: 24, maxHours: 48 })).toBe(
      expected,
    );
  });

  it("rejects both durationSeconds and durationHours", () => {
    expect(() =>
      normalizePollInput({
        question: "Q",
        options: ["A", "B"],
        durationSeconds: 60,
        durationHours: 1,
      }),
    ).toThrow(/mutually exclusive/);
  });

  describe("resolvePollMaxSelections", () => {
    it("returns 1 when multiselect is false", () => {
      expect(resolvePollMaxSelections(5, false)).toBe(1);
    });

    it("returns 1 when multiselect is undefined", () => {
      expect(resolvePollMaxSelections(5, undefined)).toBe(1);
    });

    it("returns optionCount when multiselect is true and options >= 2", () => {
      expect(resolvePollMaxSelections(5, true)).toBe(5);
    });

    it("returns at least 2 when multiselect is true", () => {
      expect(resolvePollMaxSelections(1, true)).toBe(2);
      expect(resolvePollMaxSelections(0, true)).toBe(2);
    });

    it("returns optionCount for exactly 2 options with multiselect", () => {
      expect(resolvePollMaxSelections(2, true)).toBe(2);
    });
  });
});
