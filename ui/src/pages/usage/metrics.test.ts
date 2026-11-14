import { expect, it } from "vitest";
import { buildPeakErrorHours } from "./metrics.ts";

it("formats the five highest nonzero server error rates", () => {
  expect(
    buildPeakErrorHours(Array(8).fill(100), [2, 4, 6, 8, 10, 12, 14, 16]).map(({ value, sub }) => ({
      value,
      sub,
    })),
  ).toEqual(
    [16, 14, 12, 10, 8].map((errors) => ({
      value: `${errors.toFixed(2)}%`,
      sub: `${errors} errors · 100 msgs`,
    })),
  );
  expect(buildPeakErrorHours([10, 0], [0, 1])).toEqual([]);
});
