// Built-CLI SQLite flip proof requires dist entrypoints before running the gateway lifecycle.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../../src/config/sessions/archive-compression.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import { replaceSqliteTranscriptEvents } from "../../src/config/sessions/session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../src/config/sessions/session-sqlite-target.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

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
    const resetCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-sessions-reset",
    );
    // Retained history: reset keeps the old generation's SQLite rows and
    // writes no reset archive artifact.
    const resetArchive = resetCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "reset" && artifact.archiveSessionId === report.legacySessionId,
    );
    expect(resetArchive).toBeUndefined();
    expect(resetCheckpoint?.sqlite.transcriptEvents ?? 0).toBeGreaterThan(0);
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

  it("keeps built gateway RPC responsive while deleting a large transcript", async () => {
    const inst = await createOpenClawTestInstance({
      name: `sqlite-archive-responsive-${randomUUID()}`,
      startTimeoutMs: 90_000,
      stopTimeoutMs: 5_000,
    });
    inst.state.applyEnv();
    const sessionId = "sqlite-large-archive-responsive";
    const sessionKey = "agent:main:dashboard:sqlite-large-archive-responsive";
    const warmupSessionId = "sqlite-archive-worker-warmup";
    const warmupSessionKey = "agent:main:dashboard:sqlite-archive-worker-warmup";
    const storePath = path.join(inst.stateDir, "agents", "main", "sessions", "sessions.json");
    const archiveDirectory = path.dirname(storePath);
    const events = createLargeTranscriptEvents(sessionId);
    const expectedArchiveContent = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    let deleteClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let probeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

    try {
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
      await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, events);
      await replaceSessionEntry(
        { sessionKey: warmupSessionKey, storePath },
        { sessionId: warmupSessionId, updatedAt: Date.now() },
      );
      await replaceSqliteTranscriptEvents(
        { sessionKey: warmupSessionKey, sessionId: warmupSessionId, storePath },
        [
          {
            type: "session",
            id: warmupSessionId,
            content: "warm the built archive worker",
          } as unknown as TestTranscriptEvent,
        ],
      );
      const databasePath = requireSqliteDatabasePath(storePath);
      expect(readSessionRowCounts(databasePath, sessionId)).toEqual({
        fts: 1,
        sessions: 1,
        transcriptEvents: events.length,
      });
      closeOpenClawAgentDatabasesForTest();

      await expect(inst.entrypoint()).resolves.toEqual(
        expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
      );
      await inst.startGateway();
      [deleteClient, probeClient] = await Promise.all([
        connectGatewayClient({
          url: inst.url,
          token: inst.gatewayToken,
          clientDisplayName: "sqlite-large-archive-delete",
          requestTimeoutMs: 120_000,
          timeoutMs: 20_000,
        }),
        connectGatewayClient({
          url: inst.url,
          token: inst.gatewayToken,
          clientDisplayName: "sqlite-large-archive-presence",
          requestTimeoutMs: 2_000,
          timeoutMs: 20_000,
        }),
      ]);
      await deleteClient.request("sessions.list", {}, { timeoutMs: 20_000 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await probeClient.request("system-presence", {}, { timeoutMs: 2_000 });
      }
      // Prime the built sidecar and OS file cache with a tiny transcript so the
      // latency assertion below measures data-size-dependent archive work.
      await deleteClient.request(
        "sessions.delete",
        { key: warmupSessionKey, deleteTranscript: true },
        { timeoutMs: 20_000 },
      );

      let archivePublishedAt: number | undefined;
      let deleteSettled = false;
      const publicationPoll = setInterval(() => {
        if (findPublishedArchive(archiveDirectory, sessionId)) {
          archivePublishedAt ??= performance.now();
        }
      }, 5);
      const deletion = deleteClient
        .request<{ archived?: string[]; deleted?: boolean; ok?: boolean }>(
          "sessions.delete",
          { key: sessionKey, deleteTranscript: true },
          { timeoutMs: 120_000 },
        )
        .finally(() => {
          deleteSettled = true;
        });
      void deletion.catch(() => undefined);
      const prePublicationProbeLatencies: number[] = [];
      const shouldProbeBeforePublication = () => !deleteSettled && archivePublishedAt === undefined;
      try {
        while (shouldProbeBeforePublication()) {
          const probeStartedAt = performance.now();
          await probeClient.request("system-presence", {}, { timeoutMs: 2_000 });
          const probeCompletedAt = performance.now();
          // Record every probe that started before publication was observed.
          // A synchronous implementation can delay this response until after
          // publication; dropping that crossing sample would hide the stall.
          prePublicationProbeLatencies.push(probeCompletedAt - probeStartedAt);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
        }
      } finally {
        clearInterval(publicationPoll);
      }

      const deleteResult = await deletion;
      expect(deleteResult).toMatchObject({ ok: true, deleted: true });
      expect(prePublicationProbeLatencies.length).toBeGreaterThan(5);
      expect(Math.max(...prePublicationProbeLatencies)).toBeLessThan(250);
      const archivedPath = deleteResult.archived?.[0];
      expect(archivedPath).toBeTruthy();

      await Promise.all([
        disconnectGatewayClient(deleteClient),
        disconnectGatewayClient(probeClient),
      ]);
      deleteClient = undefined;
      probeClient = undefined;
      await inst.stopGateway();

      const archivedContent = readSessionArchiveContentSync(archivedPath ?? "");
      expect(Buffer.byteLength(archivedContent)).toBe(Buffer.byteLength(expectedArchiveContent));
      expect(sha256(archivedContent)).toBe(sha256(expectedArchiveContent));
      expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
      await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
      expect(readSessionRowCounts(databasePath, sessionId)).toEqual({
        fts: 0,
        sessions: 0,
        transcriptEvents: 0,
      });
    } finally {
      await Promise.allSettled(
        [deleteClient, probeClient]
          .filter((client): client is NonNullable<typeof client> => client !== undefined)
          .map((client) => disconnectGatewayClient(client)),
      );
      await inst.stopGateway();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await inst.cleanup();
    }
  }, 180_000);
});

type TestTranscriptEvent = Parameters<typeof replaceSqliteTranscriptEvents>[1][number];

function createLargeTranscriptEvents(sessionId: string): TestTranscriptEvent[] {
  const indexedMessage = {
    type: "message",
    id: "sqlite-large-archive-indexed-message",
    parentId: null,
    message: {
      role: "user",
      content: [{ type: "text", text: "large archive searchable marker" }],
    },
    timestamp: Date.now(),
  } as unknown as TestTranscriptEvent;
  return [
    indexedMessage,
    ...Array.from(
      { length: 63 },
      (_, index) =>
        ({
          type: "session",
          id: `${sessionId}-${index}`,
          content: `${index}:${randomBytes(768 * 1024).toString("base64")}`,
        }) as unknown as TestTranscriptEvent,
    ),
  ];
}

function findPublishedArchive(archiveDirectory: string, sessionId: string): string | undefined {
  const prefix = `${sessionId}.jsonl.deleted.`;
  try {
    return fs
      .readdirSync(archiveDirectory)
      .find((entry) => entry.startsWith(prefix) && !entry.endsWith(".tmp"));
  } catch {
    return undefined;
  }
}

function requireSqliteDatabasePath(storePath: string): string {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`could not resolve SQLite database path for ${storePath}`);
  }
  return target.path;
}

function readSessionRowCounts(
  databasePath: string,
  sessionId: string,
): {
  fts: number;
  sessions: number;
  transcriptEvents: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: "session_transcript_fts" | "sessions" | "transcript_events") => {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count: number };
      return Number(row.count);
    };
    return {
      fts: count("session_transcript_fts"),
      sessions: count("sessions"),
      transcriptEvents: count("transcript_events"),
    };
  } finally {
    database.close();
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
