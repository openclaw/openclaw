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
      "after-startup-import",
      "after-doctor-inspect",
      "after-doctor-validate",
      "after-gateway-restart",
      "after-chat-send",
      "after-full-agent-turn",
      "after-manual-compaction",
      "after-plugin-sdk-consumer",
      "after-cleanup-pruning",
      "after-doctor-import-idempotence",
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
    expect(report.checkpoints.some((checkpoint) => checkpoint.label === "after-doctor-fix")).toBe(
      false,
    );
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-startup-import" &&
          checkpoint.gatewayLogTail?.includes(
            "session: imported legacy session metadata/transcripts into SQLite",
          ) === true &&
          report.oldStateSessionKeys.every((key) =>
            checkpoint.sqlite.trackedEntries.some((entry) => entry.sessionKey === key),
          ) &&
          checkpoint.sqlite.sessionEntries >= 7 &&
          checkpoint.sqlite.transcriptEvents >= 13,
      ),
    ).toBe(true);
    const startupImportCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-startup-import",
    );
    expect(
      startupImportCheckpoint?.archiveArtifacts.some(
        (artifact) =>
          artifact.path.includes(`${report.legacySessionId}.trajectory.jsonl`) &&
          artifact.textTail?.includes("trajectory") === true,
      ),
    ).toBe(true);
    expect(
      startupImportCheckpoint?.archiveArtifacts.some(
        (artifact) =>
          artifact.path.includes("old-orphan.deleted.jsonl") &&
          artifact.textTail?.includes("old-orphan") === true,
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
    const resetCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-sessions-reset",
    );
    const resetArchive = resetCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "reset" && artifact.archiveSessionId === report.legacySessionId,
    );
    expect(resetArchive?.messageTexts).toContain("legacy hello");
    expect(resetArchive?.messageTexts).toContain("sqlite user-facing send before reset");
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
    expect(report.manualCompaction).toMatchObject({
      checkpointCount: 1,
      compacted: true,
      sessionKey: report.manualCompactionSessionKey,
    });
    expect(report.manualCompaction?.sessionFileMarker.startsWith("sqlite:")).toBe(true);
    expect(report.manualCompaction?.rowCountBefore).toBeGreaterThanOrEqual(2);
    expect(report.manualCompaction?.rowCountAfter).toBeGreaterThanOrEqual(1);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-manual-compaction" &&
          checkpoint.activeJsonl.length === 0 &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) =>
              entry.sessionKey === report.manualCompactionSessionKey &&
              Array.isArray(entry.entry?.compactionCheckpoints) &&
              entry.entry.compactionCheckpoints.length >= 1,
          ),
      ),
    ).toBe(true);
    expect(report.pluginSdkConsumer).toMatchObject({
      activeJsonlForSessionExists: false,
      latestAssistantTextBeforeAppend: report.fullTurnAssistantText,
      latestAssistantTextAfterAppend: "sqlite sdk consumer appended by identity",
      sessionKey: report.pluginSdkSessionKey,
    });
    expect(report.pluginSdkConsumer?.sessionFileMarker.startsWith("sqlite:")).toBe(true);
    expect(report.pluginSdkConsumer?.listedSessionKeys).toContain(report.pluginSdkSessionKey);
    expect(report.pluginSdkConsumer?.transcriptEventsAfterAppend).toBeGreaterThan(
      report.pluginSdkConsumer?.transcriptEventsBeforeAppend ?? 0,
    );
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-plugin-sdk-consumer" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) =>
              entry.sessionKey === report.pluginSdkSessionKey && entry.transcriptEvents >= 3,
          ),
      ),
    ).toBe(true);
    const cleanupCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-cleanup-pruning",
    );
    expect(
      cleanupCheckpoint?.sqlite.trackedEntries.some(
        (entry) => entry.sessionKey === report.cleanupPruneSessionKey,
      ),
    ).toBe(false);
    const cleanupArchive = cleanupCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-cleanup-prune",
    );
    expect(cleanupArchive?.messageTexts).toContain("sqlite cleanup prune me");
    const idempotenceCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-doctor-import-idempotence",
    );
    expect(idempotenceCheckpoint?.doctor).toMatchObject({
      code: 0,
      mode: "import",
      totals: expect.objectContaining({
        importedEntries: 0,
        importedTranscriptEvents: 0,
      }),
    });
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
    const deleteCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-sessions-delete",
    );
    const deleteArchive = deleteCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-delete-session",
    );
    expect(deleteArchive?.messageTexts).toContain("delete me");
    const sharedFirstCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-shared-first-delete",
    );
    expect(
      sharedFirstCheckpoint?.archiveArtifacts.some(
        (artifact) =>
          artifact.archiveReason === "deleted" &&
          artifact.archiveSessionId === "sqlite-shared-session",
      ),
    ).toBe(false);
    const sharedFinalCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-shared-final-delete",
    );
    const sharedFinalArchive = sharedFinalCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-shared-session",
    );
    expect(sharedFinalArchive?.messageTexts).toContain("shared");
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
