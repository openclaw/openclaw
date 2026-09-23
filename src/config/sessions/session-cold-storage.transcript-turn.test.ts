import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn, replaceSessionEntrySync } from "./session-accessor.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

describe("selected transcript turn cold restoration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databasePaths: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const databasePath of databasePaths.splice(0)) {
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

  async function createFixture() {
    const root = tempDirs.make("openclaw-cold-turn-");
    const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    databasePaths.push(storePath);
    const fixture = await createSessionColdStorageFixture(storePath, "global");
    expect(
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    replaceSessionEntrySync(fixture.scope, {
      sessionId: historicalId,
      updatedAt: 1,
      lifecycleRevision: "selected",
    });
    const descriptor = readSessionColdTranscript(fixture.database(), historicalId);
    expect(descriptor).toBeDefined();
    const append = () =>
      persistSessionTranscriptTurn(
        { ...fixture.scope, sessionKey: "agent:main:global" },
        {
          expectedSessionId: historicalId,
          expectedLifecycleRevision: "selected",
          messages: [{ message: { role: "user", content: "Resume selected history" } }],
          updateMode: "none",
        },
      );
    const replaceRevision = () =>
      replaceSessionEntrySync(fixture.scope, {
        sessionId: historicalId,
        updatedAt: 2,
        lifecycleRevision: "successor",
      });
    return { ...fixture, append, descriptor, replaceRevision };
  }

  it("restores raw-key history and appends through the qualified identity", async () => {
    const fixture = await createFixture();
    await expect(fixture.append()).resolves.toMatchObject({ appendedCount: 1 });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
    const events = loadTranscriptEventsSync(fixture.scope);
    expect(events).toContainEqual(expect.objectContaining({ id: "history-user" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ role: "user", content: "Resume selected history" }),
      }),
    );
    expect(fixture.database().prepare("SELECT session_key FROM session_nodes").all()).toEqual([
      { session_key: "global" },
    ]);
  });

  it.each(["before restoration", "at worker commit"])(
    "keeps the archive cold when the captured revision changes %s",
    async (timing) => {
      const fixture = await createFixture();
      let commitRequested = false;
      if (timing === "at worker commit") {
        const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
        vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
          (params) => {
            if (params.expectedMessageType !== "reclaimed") {
              return original(params);
            }
            return original({
              ...params,
              withWriteAdmission: (run, diagnostics) =>
                params.withWriteAdmission((refusal) => {
                  if (!refusal) {
                    fixture.replaceRevision();
                  }
                  return run(refusal);
                }, diagnostics),
              onCommitRequest: () => {
                commitRequested = true;
                params.onCommitRequest();
              },
            });
          },
        );
      }
      const pending = fixture.append();
      if (timing === "before restoration") {
        fixture.replaceRevision();
      }
      await expect(pending).resolves.toMatchObject({
        rejectedReason: "session-rebound",
        appendedCount: 0,
      });
      expect(commitRequested).toBe(timing === "at worker commit");
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(
        fixture.descriptor,
      );
      expect(
        fixture
          .database()
          .prepare("SELECT seq FROM transcript_events WHERE session_id = ?")
          .all(historicalId),
      ).toEqual([]);
    },
  );
});
