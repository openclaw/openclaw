import { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationResult } from "./session-accessor.sqlite-lifecycle-types.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import type * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

type WorkerOwner = Parameters<
  Parameters<typeof reclamationWorker.withSqliteReclamationWorker>[2]
>[0];
const storage = vi.hoisted(() => ({
  run: vi.fn<WorkerOwner["run"]>(),
  committed: false,
  database: { db: { isTransaction: false } },
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
    database: storage.database,
    claim: {
      identity: "synthetic-file",
      assertCurrent: () => {},
      isCurrent: () => true,
      release: storage.release,
    },
  }),
}));
vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-db.js")>();
  return {
    ...actual,
    getOpenClawAgentDatabaseIfOpen: (
      request: Parameters<typeof actual.getOpenClawAgentDatabaseIfOpen>[0],
    ) =>
      request?.path === options.path
        ? storage.database
        : actual.getOpenClawAgentDatabaseIfOpen(request),
  };
});
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
  ) =>
    await run({
      assertCurrent: () => {},
      commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      signal: new AbortController().signal,
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

test("maintenance preparation yields to foreground writes and retains commit admission through publication", async () => {
  storage.committed = false;
  storage.release.mockClear();
  const preparation = createDeferredCore();
  const validationGap = createDeferredCore();
  const commitGap = createDeferredCore();
  const archiveEntered = createDeferredCore();
  const releaseArchive = createDeferredCore();
  const admissions: number[] = [];
  const order: string[] = [];
  const write = (name: string, onEntered?: () => void) =>
    runExclusiveSqliteSessionWrite(
      options,
      async () => {
        onEntered?.();
        order.push(name);
      },
      "session-entry.patch",
    );
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     let admissions = 0;
     parentPort.on("message", (message) => {
       if (message.type === "start") {
         parentPort.postMessage({ type: "preparation" });
       } else if (message.type === "prepare") {
         parentPort.postMessage({ type: "admission-request", operationId: 1 });
       } else if (message.type === "continue") {
         parentPort.postMessage({ type: "admission-request", operationId: 1 });
       } else if (message.type === "admission" && ++admissions === 1) {
         parentPort.postMessage({ type: "admission-release", operationId: 1 });
         parentPort.postMessage({ type: "validation-gap" });
       } else if (message.type === "admission") {
         parentPort.postMessage({ type: "commit-gap" });
       } else if (message.type === "settle") {
         parentPort.postMessage({ type: "reclaimed", operationId: 1, settled: true,
           result: { kind: "maintenance-finalize", value: {
             archivedTranscripts: [], committedEntryIndices: [] } } });
         parentPort.close();
       }
     });`,
    { eval: true, execArgv: [] },
  );
  worker.on("message", (message) => {
    if (message.type === "preparation") {
      preparation.resolve();
    } else if (message.type === "validation-gap") {
      validationGap.resolve();
    } else if (message.type === "commit-gap") {
      commitGap.resolve();
    }
  });
  storage.run.mockImplementation((params) =>
    runSqliteMutationWorkerRequest<SqliteSessionReclamationResult>({
      transport: { kind: "dedicated", channel: worker },
      operationId: 1,
      completion: "exit",
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
    onWorkerResult: () => {
      storage.committed = true;
      order.push("published");
    },
    plan: {
      kind: "maintenance-finalize",
      agentId: "main",
      databaseOptions: options,
      entries: [],
      materializedPlans: [],
    },
  });
  const settledFinalization = finalization.then(
    () => {
      throw new Error("Finalization settled before its protocol checkpoint");
    },
    (error: unknown) => {
      throw error;
    },
  );
  // Observe early failure while any protocol checkpoint is pending.
  void settledFinalization.catch(() => {});
  let precedingWriter: Promise<void> | undefined;
  let preparationWriter: Promise<void> | undefined;
  let validationWriter: Promise<void> | undefined;
  let laterWriter: Promise<void> | undefined;
  let laterObservedCommit = false;
  try {
    // A preceding archive request can still acquire this store's writer.
    precedingWriter = write("preceding-writer");
    await precedingWriter;
    releaseArchive.resolve();
    await earlierArchive;
    await Promise.race([preparation.promise, settledFinalization]);
    preparationWriter = write("preparation-writer");
    worker.postMessage({ type: "prepare" }, []);
    await Promise.race([validationGap.promise, settledFinalization]);
    expect(order).toEqual(["preceding-writer", "preparation-writer"]);
    validationWriter = write("validation-writer");
    worker.postMessage({ type: "continue" }, []);
    await Promise.race([commitGap.promise, settledFinalization]);
    expect(order).toEqual(["preceding-writer", "preparation-writer", "validation-writer"]);
    laterWriter = write("later-writer", () => {
      laterObservedCommit = storage.committed;
    });
    worker.postMessage({ type: "settle" }, []);
    await expect(finalization).resolves.toMatchObject({ kind: "maintenance-finalize" });
    await Promise.all([preparationWriter, validationWriter, laterWriter]);
    expect(admissions).toEqual([1, 2]);
    expect(laterObservedCommit).toBe(true);
    expect(order).toEqual([
      "preceding-writer",
      "preparation-writer",
      "validation-writer",
      "published",
      "later-writer",
    ]);
    expect(storage.release).toHaveBeenCalledOnce();
  } finally {
    releaseArchive.resolve();
    worker.postMessage({ type: "settle" }, []);
    await Promise.allSettled([
      earlierArchive,
      precedingWriter,
      preparationWriter,
      validationWriter,
      finalization,
      laterWriter,
    ]);
    await worker.terminate();
  }
});
