// @vitest-environment node
import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../../../src/test-utils/node-process.ts";

it("keeps the current hour inside the 24h pulse after a repeated DST hour", () => {
  // Native Date captures the host time zone per process; Vitest workers cannot switch it.
  const moduleUrl = new URL("./activity-pulse-window.ts", import.meta.url).href;
  // 01:30 EST on Nov 2: 24 hours earlier is the repeated 01:30 of Nov 1.
  const now = Date.UTC(2026, 10, 2, 6, 30);
  const output = execNodeEvalSync(
    `import { activityPulseBoundaries } from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify(activityPulseBoundaries("24h", ${now})));`,
    { env: { ...process.env, TZ: "America/New_York" }, timeout: 10_000 },
  );
  const boundaries = JSON.parse(output) as number[];

  expect(boundaries).toHaveLength(26);
  expect(boundaries[0]).toBe(Date.UTC(2026, 10, 1, 6));
  expect(boundaries.at(-1)).toBe(Date.UTC(2026, 10, 2, 7));
});
