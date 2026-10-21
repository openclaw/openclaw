import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  replayScheduledContextFixture,
  type ScheduledContextFixture,
} from "./execution-context.fixtures.test-support.js";

// Job shapes found by scripts/dev/cron-context-replay.mts on a real Gateway,
// anonymized. Regenerate with --emit-fixtures when new shapes appear.
const fixtures = JSON.parse(
  readFileSync(new URL("./execution-context.fixtures.json", import.meta.url), "utf8"),
) as ScheduledContextFixture[];

describe("scheduled execution context on stored job shapes", () => {
  it("covers the stored shapes", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((fixture) => [fixture.job.name, fixture] as const))(
    "%s keeps its pinned decisions",
    (_name, fixture) => {
      expect(replayScheduledContextFixture(fixture)).toEqual(fixture.expected);
    },
  );

  it("never produces an unexpected gain", () => {
    for (const fixture of fixtures) {
      const outcome = replayScheduledContextFixture(fixture);
      expect(Object.values(outcome.labels)).not.toContain("gain-unexpected");
    }
  });
});
