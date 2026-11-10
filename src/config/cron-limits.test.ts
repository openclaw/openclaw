import { expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

it.each([1, 2, 12])("accepts positive integer cron concurrency overrides: %s", (value) => {
  const cron = { maxConcurrentRuns: value, triggers: { maxConcurrentEvaluations: value } };
  expect(OpenClawSchema.parse({ cron }).cron).toEqual(cron);
});

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "2", null])(
  "rejects invalid concurrency overrides consistently: %s",
  (value) => {
    for (const cron of [
      { maxConcurrentRuns: value },
      { triggers: { maxConcurrentEvaluations: value } },
    ]) {
      expect(OpenClawSchema.safeParse({ cron }).success).toBe(false);
    }
  },
);
