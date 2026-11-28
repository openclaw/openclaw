import { describe, expect, it } from "vitest";
import {
  projectHistoricalSucceededUpdateRun,
  projectUpdateRunHistory,
} from "./update-run-history-projection.js";

describe("update-run-history-projection", () => {
  it("projects an older succeeded update run as historical when the gateway serves a newer version", () => {
    const run = {
      status: "succeeded" as const,
      reason: null,
      after: { version: "2026.9.5", buildId: "build-old" },
      verification: {
        serviceRunning: true,
        runningVersion: "2026.9.5",
        runningBuildId: "build-old",
      },
    };

    expect(
      projectHistoricalSucceededUpdateRun(run, {
        version: "2026.11.3",
        buildId: "build-new",
      }),
    ).toBe("Historical update run (version was 2026.9.5) — Gateway is now serving 2026.11.3.");

    // Failure projection must stay null so sidebar warning / historicalFailure callers do not fire.
    expect(
      projectUpdateRunHistory(run, {
        version: "2026.11.3",
        buildId: "build-new",
      }),
    ).toBeNull();
  });

  it("returns null when the succeeded update run matches the serving version and build", () => {
    const run = {
      status: "succeeded" as const,
      after: { version: "2026.11.3", buildId: "build-new" },
      verification: {
        serviceRunning: true,
        runningVersion: "2026.11.3",
        runningBuildId: "build-new",
      },
    };

    expect(
      projectHistoricalSucceededUpdateRun(run, {
        version: "2026.11.3",
        buildId: "build-new",
      }),
    ).toBeNull();
  });
});
