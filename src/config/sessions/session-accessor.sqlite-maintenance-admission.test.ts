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
  requestController: undefined as AbortController | undefined,
  requestRefusal: undefined as Error | undefined,
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
    run: (request: {
      assertCurrent: () => void;
      commitGate: SharedArrayBuffer;
      signal: AbortSignal;
    }) => Promise<T>,
  ) => {
    const signal = storage.requestController?.signal ?? new AbortController().signal;
    return await run({
      assertCurrent: () => {
        if (signal.aborted) {
          throw storage.requestRefusal ?? signal.reason;
        }
      },
      commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      signal,
    });
  },
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
      signal?: AbortSignal,
    ) =>
      await runInArchiveFifo(async () => {
        assertCurrent();
        return await run({ assertCurrent, run: storage.run });
      }, signal),
  };
});

test("cancels waiting maintenance writer admission with the owner's specific refusal", async () => {
  storage.committed = false;
  storage.release.mockClear();
  storage.requestController = new AbortController();
  const refusal = (storage.requestRefusal = new Error("Maintenance source authority was revoked"));
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const queued = createDeferredCore();
  const value: SqliteSessionReclamationResult = {
    kind: "maintenance-finalize",
    value: { archivedTranscripts: [], changedEntries: [], committedEntries: [] },
  };
  const runAdmitted = vi.fn(async (rejected?: { error: unknown }) => {
    if (rejected) {
      throw rejected.error;
    }
    return value;
  });
  let holding: Promise<void> | undefined;
  storage.run.mockImplementation(async (params) => {
    holding = runExclusiveSqliteSessionWrite(
      options,
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
      },
      "session-entry.patch",
    );
    await writerEntered.promise;
    const waiting = params.withWriteAdmission(runAdmitted, { admissionId: 1 });
    queued.resolve();
    await waiting;
    return value;
  });
  const outcome: { settled: boolean; error?: unknown } = { settled: false };
  const request = runSqliteSessionReclamation({
    forceInProcess: false,
    plan: {
      kind: "maintenance-finalize",
      agentId: "main",
      databaseOptions: options,
      entries: [],
      materializedPlans: [],
    },
  }).then(
    () => {
      outcome.settled = true;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  try {
    await queued.promise;
    storage.requestController.abort(new Error("Generic queued writer cancellation"));
    await nextTurn();
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBe(refusal);
    expect(runAdmitted).not.toHaveBeenCalled();
    expect(storage.committed).toBe(false);
    expect(storage.release).toHaveBeenCalledOnce();
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([holding, request]);
    storage.requestController = undefined;
    storage.requestRefusal = undefined;
  }
});

test("maintenance prepares before FIFO and retains admitted finalization through publication", async () => {
  storage.committed = false;
  storage.release.mockClear();
  const validationGap = createDeferredCore();
  const writeAdmitted = createDeferredCore();
  const archiveEntered = createDeferredCore();
  const releaseArchive = createDeferredCore();
  const admissions: number[] = [];
  const order: string[] = [];
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     let requested = false;
     let admitted = false;
     let finishRequested = false;
     const finish = () => {
       if (!admitted || !finishRequested) return;
       parentPort.postMessage({ type: "reclaimed", operationId: 1, settled: true,
         result: { kind: "maintenance-finalize", value: {
           archivedTranscripts: [], changedEntries: [], committedEntries: [] } } });
       parentPort.close();
     };
     parentPort.on("message", (message) => {
       if (message.type === "start") {
         parentPort.postMessage({ type: "validation-gap" });
       } else if (message.type === "continue") {
         if (!requested) {
           requested = true;
           parentPort.postMessage({ type: "admission-request", operationId: 1, admissionId: 1 });
         }
       } else if (message.type === "admission" && message.admissionId === 1) {
         admitted = true;
         parentPort.postMessage({ type: "commit-request", operationId: 1 });
         parentPort.postMessage({ type: "write-admitted" });
         finish();
       } else if (message.type === "finish") {
         finishRequested = true;
         finish();
       }
     });`,
    { eval: true, execArgv: [] },
  );
  worker.on("message", (message) => {
    if (message.type === "validation-gap") {
      validationGap.resolve();
    } else if (message.type === "write-admitted") {
      writeAdmitted.resolve();
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
  let preparationWriter: Promise<void> | undefined;
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
    let preparationWriterRan = false;
    preparationWriter = runExclusiveSqliteSessionWrite(
      options,
      async () => {
        preparationWriterRan = true;
        expect(storage.committed).toBe(false);
        order.push("preparation-writer");
      },
      "session-entry.patch",
    );
    await nextTurn();
    expect(preparationWriterRan).toBe(true);
    await preparationWriter;
    worker.postMessage({ type: "continue" }, []);
    await writeAdmitted.promise;
    laterWriter = runExclusiveSqliteSessionWrite(
      options,
      async () => {
        laterObservedCommit = storage.committed;
        order.push("later-writer");
      },
      "session-entry.patch",
    );
    await nextTurn();
    expect(order).toEqual(["preceding-writer", "preparation-writer"]);
    worker.postMessage({ type: "finish" }, []);
    await expect(finalization).resolves.toMatchObject({ kind: "maintenance-finalize" });
    await laterWriter;
    expect(admissions).toEqual([1]);
    expect(laterObservedCommit).toBe(true);
    expect(order).toEqual(["preceding-writer", "preparation-writer", "later-writer"]);
    expect(storage.release).toHaveBeenCalledOnce();
  } finally {
    releaseArchive.resolve();
    worker.postMessage({ type: "continue" }, []);
    worker.postMessage({ type: "finish" }, []);
    await Promise.allSettled([
      earlierArchive,
      precedingWriter,
      preparationWriter,
      finalization,
      laterWriter,
    ]);
    await worker.terminate();
  }
});
