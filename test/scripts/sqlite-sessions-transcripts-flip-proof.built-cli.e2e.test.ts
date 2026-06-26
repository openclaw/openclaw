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
    expect(report.pluginSdkConsumer).toMatchObject({
      activeJsonlForSessionExists: false,
      latestAssistantTextBeforeAppend: report.fullTurnAssistantText,
      latestAssistantTextAfterAppend: "sqlite sdk consumer appended by identity",
      sessionKey: report.pluginSdkSessionKey,
    });
    expect(report.pluginSdkConsumer?.sessionFileMarker.startsWith("sqlite:")).toBe(true);
    expect(report.pluginSdkConsumer?.listedSessionKeys).toContain(report.pluginSdkSessionKey);
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
  }, 180_000);
});
