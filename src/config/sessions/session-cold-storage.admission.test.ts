import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  createTrajectoryEvent,
} from "../../trajectory/runtime-store.test-support.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

afterEach(() => vi.restoreAllMocks());

it("bounds restore reservations and lets a foreground writer finish before hot publication", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(state.statePath("restore.sqlite"));
    await replaceTranscriptEvents(
      fixture.scope,
      Array.from({ length: 10_000 }, (_, index) => ({
        type: "message",
        id: `restore-${index}`,
        parentId: index ? `restore-${index - 1}` : null,
        message: { role: "user", content: "synthetic restoration payload ".repeat(150) },
      })),
    );
    await waitForSessionTranscriptIndexReconcile(fixture.options);
    fixture
      .database()
      .prepare(
        "UPDATE session_windows SET updated_at=1, transcript_updated_at=1 WHERE session_id=?",
      )
      .run(historicalId);
    const expected = fixture.snapshot();
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.options.path) });
    const holds: number[] = [];
    const writes: Promise<void>[] = [];
    let foregroundSawCold = false;
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (
          params.expectedMessageType !== "reclaimed" ||
          params.diagnostics?.kind !== "cold-restore"
        ) {
          return originalWorker(params);
        }
        return originalWorker({
          ...params,
          withWriteAdmission: (run, diagnostics, operation) =>
            params.withWriteAdmission(
              async (refusal) => {
                const started = performance.now();
                try {
                  return await run(refusal);
                } finally {
                  holds.push(performance.now() - started);
                  if (
                    writes.length === 0 &&
                    readSessionColdTranscript(fixture.database(), historicalId) &&
                    fixture
                      .database()
                      .prepare(
                        "SELECT event_json IS NOT NULL OR event_zstd IS NOT NULL AS restored FROM transcript_events WHERE session_id=? AND seq=0",
                      )
                      .get(historicalId)?.restored === 1
                  ) {
                    const write = withOpenClawAgentDatabaseWrite(
                      fixture.options,
                      () => {
                        foregroundSawCold = Boolean(
                          readSessionColdTranscript(fixture.database(), historicalId),
                        );
                        const trace = createTrajectoryEvent({
                          type: "restore-interleave",
                          sessionId: currentId,
                          seq: 0,
                        });
                        appendSqliteTrajectoryRuntimeEvents(
                          { ...fixture.scope, sessionId: currentId },
                          [trace],
                        );
                      },
                      fixture.database(),
                    );
                    void write.catch(() => {});
                    writes.push(write);
                  }
                }
              },
              diagnostics,
              operation,
            ),
        });
      },
    );
    await restoreSessionColdTranscript(fixture.scope);
    await Promise.all(writes);
    expect(Math.max(...holds)).toBeLessThan(1_000);
    expect(foregroundSawCold).toBe(true);
    expect(fixture.snapshot()).toEqual(expected);
  }));

it("queues a borrowed foreground write while a cold Worker owns admission", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    const writerScope = { ...fixture.scope, sessionId: currentId };
    const currentBefore = loadTranscriptEventsSync(writerScope);
    const expectedDatabase = fixture.database();
    const writes: Promise<void>[] = [];
    let foregroundEntered = false;
    let enteredBeforeAuthorization: boolean | undefined;
    const trace = createTrajectoryEvent({ type: "proof", sessionId: currentId, seq: 0 });
    trace.sessionKey = writerScope.sessionKey;
    const foregroundWrite = () => {
      foregroundEntered = true;
      appendSqliteTrajectoryRuntimeEvents(writerScope, [trace]);
    };
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (params.expectedMessageType !== "reclaimed" || writes.length > 0) {
          return originalWorker(params);
        }
        let inWriteAdmission: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
        return originalWorker({
          ...params,
          withWriteAdmission: (run, diagnostics, operation) =>
            params.withWriteAdmission(
              (refusal) => {
                inWriteAdmission = AsyncLocalStorage.snapshot();
                return run(refusal);
              },
              diagnostics,
              operation,
            ),
          onCommitRequest: () => {
            if (!inWriteAdmission) {
              throw new Error("Cold Worker requested commit without writer admission");
            }
            inWriteAdmission(() => {
              const write = withOpenClawAgentDatabaseWrite(
                fixture.options,
                foregroundWrite,
                expectedDatabase,
              );
              void write.catch(() => {});
              writes.push(write);
              enteredBeforeAuthorization = foregroundEntered;
            });
            params.onCommitRequest();
          },
        });
      },
    );
    const [maintenance] = await Promise.allSettled([
      runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ]);
    const outcomes = await Promise.allSettled(writes);
    expect(maintenance).toEqual({
      status: "fulfilled",
      value: { archivedTranscripts: 1, externalizedTranscripts: 0 },
    });
    expect({ enteredBeforeAuthorization, foregroundEntered, outcomes }).toEqual({
      enteredBeforeAuthorization: false,
      foregroundEntered: true,
      outcomes: [{ status: "fulfilled", value: undefined }],
    });
    expect((await loadSqliteTrajectoryRuntimeEvents(writerScope)).map((row) => row.type)).toEqual([
      "proof",
    ]);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    expect(loadTranscriptEventsSync(writerScope)).toEqual(currentBefore);
  }));
