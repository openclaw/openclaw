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
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";

afterEach(() => vi.restoreAllMocks());

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
        if (params.expectedMessageType !== "reclaimed") {
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
