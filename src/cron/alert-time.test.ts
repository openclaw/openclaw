import { describe, expect, it } from "vitest";
import { formatCronAlertEventTime } from "./alert-time.js";
import type { CronJob } from "./types.js";

const eventTimeMs = Date.parse("2026-05-04T07:20:00.000Z");

describe("formatCronAlertEventTime", () => {
  it.each([
    {
      schedule: { kind: "cron", expr: "0 11 * * *", tz: "Asia/Dubai" } as const,
      expected: "2026-05-04 11:20 (Asia/Dubai)",
    },
    {
      schedule: { kind: "every", everyMs: 60_000 } as const,
      expected: "2026-05-04 07:20 (UTC)",
    },
    {
      schedule: { kind: "cron", expr: "0 11 * * *", tz: "Invalid/Timezone" } as const,
      expected: "2026-05-04 07:20 (UTC)",
    },
  ])("formats $schedule.kind schedules", ({ schedule, expected }) => {
    const job = { schedule } satisfies Pick<CronJob, "schedule">;
    expect(formatCronAlertEventTime({ job, eventTimeMs })).toBe(expected);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits invalid event time %s",
    (invalidEventTimeMs) => {
      const job = {
        schedule: { kind: "every", everyMs: 60_000 },
      } satisfies Pick<CronJob, "schedule">;
      expect(formatCronAlertEventTime({ job, eventTimeMs: invalidEventTimeMs })).toBeUndefined();
    },
  );
});
