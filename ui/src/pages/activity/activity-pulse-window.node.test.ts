// @vitest-environment node
import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../../../src/test-utils/node-process.ts";
import type { ActivityTimeFilter } from "./session-activity.ts";

function readBoundaries(time: ActivityTimeFilter, now: number, zone: string): number[] {
  // Native Date captures the host time zone per process; Vitest workers cannot switch it.
  const moduleUrl = new URL("./activity-pulse-window.ts", import.meta.url).href;
  const output = execNodeEvalSync(
    `import { activityPulseBoundaries } from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify(activityPulseBoundaries(${JSON.stringify(time)}, ${now})));`,
    { env: { ...process.env, TZ: zone }, timeout: 10_000 },
  );
  return JSON.parse(output) as number[];
}

it("keeps the current hour inside the 24h pulse after a repeated DST hour", () => {
  // 01:30 EST on Nov 2: 24 hours earlier is the repeated 01:30 of Nov 1.
  const boundaries = readBoundaries("24h", Date.UTC(2026, 10, 2, 6, 30), "America/New_York");

  expect(boundaries).toHaveLength(26);
  expect(boundaries[0]).toBe(Date.UTC(2026, 10, 1, 6));
  expect(boundaries.at(-1)).toBe(Date.UTC(2026, 10, 2, 7));
});

it.each([
  {
    zone: "America/New_York",
    now: "2026-03-09T00:15:00-04:00",
    first7d: "2026-03-01T00:00:00-05:00",
    first30d: "2026-02-06T00:00:00-05:00",
    tomorrow: "2026-03-10T00:00:00-04:00",
  },
  {
    zone: "Australia/Lord_Howe",
    now: "2026-10-05T00:15:00+11:00",
    first7d: "2026-09-27T00:00:00+10:30",
    first30d: "2026-09-04T00:00:00+10:30",
    tomorrow: "2026-10-06T00:00:00+11:00",
  },
])(
  "starts daily bars on the local date of the elapsed cutoff after spring forward in $zone",
  (testCase) => {
    const tomorrow = Date.parse(testCase.tomorrow);
    const windows = (["7d", "30d"] as const).map((time) => {
      const edges = readBoundaries(time, Date.parse(testCase.now), testCase.zone);
      return [edges[0], edges.at(-1)];
    });
    expect(windows).toEqual([
      [Date.parse(testCase.first7d), tomorrow],
      [Date.parse(testCase.first30d), tomorrow],
    ]);
  },
);
