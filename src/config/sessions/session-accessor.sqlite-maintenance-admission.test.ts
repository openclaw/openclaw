import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationResult } from "./session-accessor.sqlite-lifecycle-types.js";
import type * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

type WorkerOwner = Parameters<
  Parameters<typeof reclamationWorker.withSqliteReclamationWorker>[2]
>[0];
const storage = vi.hoisted(() => ({
  run: vi.fn<WorkerOwner["run"]>(),
  committed: false,
  release: vi.fn(),
}));
const options = {
  agentId: "main",
  path: "/synthetic/maintenance-admission.sqlite",
  env: { OPENCLAW_STATE_DIR: "/synthetic/maintenance-admission" },
};

// Only storage boundaries are substituted; both FIFOs and request context restoration are real.
vi.mock("../../infra/node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/node-sqlite.js")>()),
  openNodeSqliteDatabase: () => {
    throw new Error("The admission ordering control must not open SQLite");
  },
}));
vi.mock("../../state/openclaw-agent-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-readonly.js")>()),
  retainOpenClawAgentDatabaseReadOnly: () => ({
    found: true,
    database: { db: {} },
    claim: {
      identity: "synthetic-file",
      assertCurrent: () => {},
      isCurrent: () => true,
      release: storage.release,
    },
  }),
}));
vi.mock("../../state/openclaw-agent-db-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-identity.js")>()),
  readOpenClawAgentDatabaseIdentity: () => ({ filename: options.path }),
}));
vi.mock("../../state/openclaw-agent-db-validation-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-validation-cache.js")>()),
  getOpenClawAgentDatabaseValidation: () => undefined,
}));
vi.mock("./session-accessor.sqlite-worker-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-worker-request.js")>()),
  withSqliteMutationWorkerLifetime: async <T>(
    _options: unknown,
    run: (request: { assertCurrent: () => void; commitGate: SharedArrayBuffer }) => Promise<T>,
  ) =>
    await run({
      assertCurrent: () => {},
      commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    }),
}));
vi.mock("./session-accessor.sqlite-reclamation-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-reclamation-commit.js")>()),
  withSqliteReclamationAuthorization: async <T>(
    _gate: SharedArrayBuffer,
    _database: unknown,
    assertCurrent: () => void,
    run: (authorize: () => unknown[]) => Promise<T>,
  ) =>
    await run(() => {
      assertCurrent();
      storage.committed = true;
      return [];
    }),
}));
vi.mock("./session-accessor.sqlite-reclamation-worker.js", async () => {
  const { runExclusiveSqliteTranscriptArchiveWorker: runInArchiveFifo } =
    await import("./session-accessor.sqlite-archive.js");
  return {
    withSqliteReclamationWorker: async <T>(
      _options: unknown,
      _claim: unknown,
      run: (worker: Pick<WorkerOwner, "assertCurrent" | "run">) => Promise<T>,
      assertCurrent: () => void,
    ) =>
      await runInArchiveFifo(async () => {
        assertCurrent();
        return await run({ assertCurrent, run: storage.run });
      }),
  };
});

test("maintenance finalization retains FIFO across preliminary admission without inverting archive ownership", async () => {
  storage.committed = false;
  storage.release.mockClear();
  const validationGap = createDeferredCore();
  const archiveEntered = createDeferredCore();
  const releaseArchive = createDeferredCore();
  const admissions: number[] = [];
  const order: string[] = [];
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     let released = false;
     let continueRequested = false;
     parentPort.on("message", (message) => {
       if (message.type === "start") {
         parentPort.postMessage({ type: "admission-request", operationId: 1, admissionId: 1 });
       } else if (message.type === "continue") {
         continueRequested = true;
         if (released) parentPort.postMessage({ type: "admission-request", operationId: 1, admissionId: 2 });
       } else if (message.type === "admission" && message.admissionId === 1) {
         parentPort.postMessage({ type: "admission-release", operationId: 1, admissionId: 1 });
         parentPort.postMessage({ type: "validation-gap" });
         released = true;
         if (continueRequested) parentPort.postMessage({ type: "admission-request", operationId: 1, admissionId: 2 });
       } else if (message.type === "admission" && message.admissionId === 2) {
         parentPort.postMessage({ type: "commit-request", operationId: 1 });
         parentPort.postMessage({ type: "reclaimed", operationId: 1, settled: true,
           result: { kind: "maintenance-finalize", value: {
             archivedTranscripts: [], changedEntries: [], committedEntries: [] } } });
         parentPort.close();
       }
     });`,
    { eval: true, execArgv: [] },
  );
  worker.on("message", (message) => {
    if (message.type === "validation-gap") {
      validationGap.resolve();
    }
  });
  storage.run.mockImplementation((params) =>
    runSqliteMutationWorkerRequest<SqliteSessionReclamationResult>({
      transport: { kind: "dedicated", channel: worker },
      operationId: 1,
      completion: "exit",
      onCommitRequest: params.onCommitRequest,
      withWriteAdmission: async (run, admission) => {
        admissions.push(admission.admissionId);
        await params.withWriteAdmission(run, admission);
      },
      dispatch: () => worker.postMessage({ type: "start" }, []),
    }),
  );
  const earlierArchive = runExclusiveSqliteTranscriptArchiveWorker(async () => {
    archiveEntered.resolve();
    await releaseArchive.promise;
  });
  await archiveEntered.promise;
  const finalization = runSqliteSessionReclamation({
    forceInProcess: false,
    plan: {
      kind: "maintenance-finalize",
      agentId: "main",
      databaseOptions: options,
      entries: [],
      materializedPlans: [],
    },
  });
  let precedingWriter: Promise<void> | undefined;
  let laterWriter: Promise<void> | undefined;
  let laterObservedCommit = false;
  try {
    await nextTurn();
    // A preceding archive request can still acquire this store's writer.
    let precedingWriterRan = false;
    precedingWriter = runExclusiveSqliteSessionWrite(
      options,
      async () => {
        precedingWriterRan = true;
        order.push("preceding-writer");
      },
      "session-entry.patch",
    );
    await nextTurn();
    expect(precedingWriterRan).toBe(true);
    await precedingWriter;
    releaseArchive.resolve();
    await earlierArchive;
    await validationGap.promise;
    laterWriter = runExclusiveSqliteSessionWrite(
      options,
      async () => {
        laterObservedCommit = storage.committed;
        order.push("later-writer");
      },
      "session-entry.patch",
    );
    await nextTurn();
    expect(order).toEqual(["preceding-writer"]);
    worker.postMessage({ type: "continue" }, []);
    await expect(finalization).resolves.toMatchObject({ kind: "maintenance-finalize" });
    await laterWriter;
    expect(admissions).toEqual([1, 2]);
    expect(laterObservedCommit).toBe(true);
    expect(order).toEqual(["preceding-writer", "later-writer"]);
    expect(storage.release).toHaveBeenCalledOnce();
  } finally {
    releaseArchive.resolve();
    worker.postMessage({ type: "continue" }, []);
    await Promise.allSettled([earlierArchive, precedingWriter, finalization, laterWriter]);
    await worker.terminate();
  }
});
