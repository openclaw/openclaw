// Tests poll input contracts and option defaults.
import { describe, expect, it } from "vitest";
import { normalizePollDurationHours, normalizePollInput } from "./polls.js";

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

  it("floors finite poll numbers and defaults non-finite values", () => {
    expect(
      normalizePollInput({
        question: "Q",
        options: ["A", "B"],
        maxSelections: 1.9,
        durationSeconds: 60.9,
        durationHours: Number.NaN,
      }),
    ).toMatchObject({ maxSelections: 1, durationSeconds: 60, durationHours: undefined });
    expect(
      normalizePollInput({
        question: "Q",
        options: ["A", "B"],
        maxSelections: Number.POSITIVE_INFINITY,
        durationSeconds: Number.NEGATIVE_INFINITY,
        durationHours: 2.9,
      }),
    ).toMatchObject({ maxSelections: 1, durationSeconds: undefined, durationHours: 2 });
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

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "preserves the fractional duration fallback for %s",
    (value) => {
      expect(normalizePollDurationHours(value, { defaultHours: 2.5, maxHours: 48 })).toBe(2.5);
    },
  );

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
});
