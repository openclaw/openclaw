import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
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
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = createTempDirTracker();
const databasePaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const databasePath of databasePaths.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

it("queues a borrowed foreground write while a cold Worker owns admission", async () => {
  const root = tempDirs.make("openclaw-cold-admission-");
  const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  databasePaths.push(storePath);
  const fixture = await createSessionColdStorageFixture(storePath);
  const writerScope = { ...fixture.scope, sessionId: currentId };
  const currentBefore = loadTranscriptEventsSync(writerScope);
  const expectedDatabase = fixture.database();
  const writes: Promise<void>[] = [];
  let foregroundEntered = false;
  let enteredBeforeAuthorization: boolean | undefined;
  const foregroundWrite = () => {
    foregroundEntered = true;
    appendSqliteTrajectoryRuntimeEvents(writerScope, [
      {
        ...createTrajectoryEvent({ type: "cold-admission-proof", sessionId: currentId, seq: 0 }),
        sessionKey: writerScope.sessionKey,
      },
    ]);
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
        withWriteAdmission: (run, diagnostics) =>
          params.withWriteAdmission((refusal) => {
            inWriteAdmission = AsyncLocalStorage.snapshot();
            return run(refusal);
          }, diagnostics),
        onCommitRequest: () => {
          if (!inWriteAdmission) {
            throw new Error("Cold Worker requested commit without writer admission");
          }
          // Model a foreground callback created inside the Worker's actual writer section.
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
  expect((await loadSqliteTrajectoryRuntimeEvents(writerScope)).map((event) => event.type)).toEqual(
    ["cold-admission-proof"],
  );
  expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  expect(loadTranscriptEventsSync(writerScope)).toEqual(currentBefore);
});
