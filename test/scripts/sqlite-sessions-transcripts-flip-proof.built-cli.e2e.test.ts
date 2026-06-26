// Built-CLI SQLite flip proof requires dist entrypoints before running the gateway lifecycle.
import { describe, expect, it } from "vitest";
import { runSqliteSessionsTranscriptsFlipProof } from "../../scripts/e2e/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip built CLI proof", () => {
  it("proves the lifecycle through the built gateway CLI entrypoint", async () => {
    const report = await runSqliteSessionsTranscriptsFlipProof({ requireBuiltCli: true });

    expect(report.gatewayEntrypoint).toEqual(
      expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
    );
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checkpoints
        .filter((checkpoint) => checkpoint.label !== "seeded-legacy-store")
        .every((checkpoint) => checkpoint.activeJsonl.length === 0),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-doctor-fix" &&
          checkpoint.doctor?.mode === "fix" &&
          checkpoint.sqlite.sessionEntries >= 4 &&
          checkpoint.sqlite.transcriptEvents >= 8,
      ),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-chat-send" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) => entry.sessionKey === report.resetSessionKey && entry.transcriptEvents >= 3,
          ),
      ),
    ).toBe(true);
  }, 180_000);
});
