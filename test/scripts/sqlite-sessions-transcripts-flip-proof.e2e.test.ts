// SQLite sessions/transcripts flip proof test runs the script-style gateway lifecycle probe.
import { describe, expect, it } from "vitest";
import { runSqliteSessionsTranscriptsFlipProof } from "../../scripts/e2e/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip proof harness", () => {
  it("proves isolated gateway lifecycle state stays SQLite-first", async () => {
    const report = await runSqliteSessionsTranscriptsFlipProof();

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkpoints.map((checkpoint) => checkpoint.label)).toEqual([
      "seeded-legacy-store",
      "after-doctor-fix",
      "after-doctor-inspect",
      "after-doctor-validate",
      "gateway-started",
      "after-gateway-restart",
      "after-chat-send",
      "after-full-agent-turn",
      "after-concurrent-multi-client",
      "after-sessions-reset",
      "after-transcript-append",
      "after-sessions-delete",
      "after-shared-first-delete",
      "after-shared-final-delete",
      "after-final-doctor-inspect",
    ]);
    expect(
      report.checkpoints
        .filter((checkpoint) => checkpoint.label !== "seeded-legacy-store")
        .every((checkpoint) => checkpoint.activeJsonl.length === 0),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "seeded-legacy-store" && checkpoint.legacyStateJsonl.length > 0,
      ),
    ).toBe(true);
    expect(
      report.checkpoints
        .filter((checkpoint) => checkpoint.label !== "seeded-legacy-store")
        .every((checkpoint) => checkpoint.legacyStateJsonl.length === 0),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-doctor-fix" &&
          checkpoint.doctor?.mode === "fix" &&
          report.oldStateSessionKeys.every((key) =>
            checkpoint.sqlite.trackedEntries.some((entry) => entry.sessionKey === key),
          ) &&
          checkpoint.sqlite.sessionEntries >= 7 &&
          checkpoint.sqlite.transcriptEvents >= 13,
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
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-full-agent-turn" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) =>
              entry.sessionKey === report.fullTurnSessionKey && entry.transcriptEvents >= 2,
          ),
      ),
    ).toBe(true);
    const concurrentCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-concurrent-multi-client",
    );
    expect(concurrentCheckpoint).toBeDefined();
    const concurrentSend = concurrentCheckpoint?.sqlite.trackedEntries.find(
      (entry) => entry.sessionKey === report.concurrentSendSessionKey,
    );
    expect(concurrentSend?.transcriptEvents).toBeGreaterThanOrEqual(2);
    expect(
      concurrentCheckpoint?.sqlite.trackedEntries.some(
        (entry) => entry.sessionKey === report.concurrentResetSessionKey && entry.sessionId,
      ),
    ).toBe(true);
    expect(
      concurrentCheckpoint?.sqlite.trackedEntries.some(
        (entry) => entry.sessionKey === report.concurrentDeleteSessionKey,
      ),
    ).toBe(false);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-transcript-append" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) => entry.sessionKey === report.resetSessionKey && entry.transcriptEvents >= 1,
          ),
      ),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-shared-first-delete" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) => entry.sessionKey === report.sharedSessionKeys[1],
          ),
      ),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-shared-final-delete" &&
          checkpoint.archiveArtifacts.length > 0,
      ),
    ).toBe(true);
  }, 180_000);
});
