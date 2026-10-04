import type { ChildProcess } from "node:child_process";
import type { Worker } from "node:worker_threads";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";

export function holdReclamationAdmission(databasePath: string) {
  const entered = createDeferred();
  const release = createDeferred();
  let admissions = 0;
  const pause = async () => {
    admissions += 1;
    entered.resolve();
    await release.promise;
  };
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertCurrent, signal) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          const execute = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
            if (
              params.plan.databaseOptions.path !== databasePath ||
              params.plan.kind !== "lifecycle-projection-commit"
            ) {
              return execute(params);
            }
            return execute({
              ...params,
              withWriteAdmission: async (performWrite, diagnostics) => {
                return params.withWriteAdmission(async (...admissionArgs) => {
                  if (!admissionArgs[0]) {
                    await pause();
                  }
                  return performWrite(...admissionArgs);
                }, diagnostics);
              },
            });
          });
          try {
            return await run(worker);
          } finally {
            spy.mockRestore();
          }
        },
        assertCurrent,
        signal,
      ),
  );
  return {
    release,
    count: () => admissions,
    async expectPending(operation: Promise<unknown>) {
      expect(
        await Promise.race([
          entered.promise.then(() => "admitted"),
          operation.then(
            () => "completed",
            () => "failed",
          ),
        ]),
      ).toBe("admitted");
    },
  };
}

export type PreparedIntegrityOwner = "executor" | "reclamation" | "other";
export type PreparedAdmissionHooks = {
  fork?: (child: ChildProcess) => void;
  afterMaterialize?: () => Promise<void>;
  integrityChecks?: SharedArrayBuffer;
  integrityRelease?: SharedArrayBuffer;
  integrityFirstCheck?: SharedArrayBuffer;
  integrityPath?: string;
  worker?: (worker: Worker, owner: PreparedIntegrityOwner) => void;
  integrityPhase?: (
    worker: Worker,
    owner: PreparedIntegrityOwner,
    phase: "checking" | "checked",
    held: boolean,
  ) => void;
};
type PreparedAdmissionContext = {
  hooks: PreparedAdmissionHooks;
  releases: Array<() => void>;
  own: <T>(promise: Promise<T>) => Promise<T>;
};
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

export function observePreparedAdmission(
  databasePath: string,
  { hooks, releases, own }: PreparedAdmissionContext,
  hold = false,
) {
  let parentChecks = 0;
  let admissions = 0;
  let settled = 0;
  let forkingIntegrity = false;
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(() => release.resolve());
  if (!hold) {
    release.resolve();
  }
  const children: Array<{
    closed: boolean;
    code: number | null;
    signal: string | null;
    phases: integrity.SqliteIntegrityWorkerPhase[];
    resultOk?: boolean;
  }> = [];
  hooks.fork = (child) => {
    if (!forkingIntegrity) {
      return;
    }
    const row = {
      closed: false,
      code: null as number | null,
      signal: null as string | null,
      phases: [] as integrity.SqliteIntegrityWorkerPhase[],
      resultOk: undefined as boolean | undefined,
    };
    children.push(row);
    child.on("message", (message: integrity.SqliteIntegrityWorkerMessage) => {
      if ("type" in message) {
        row.phases.push(message.phase);
      } else {
        row.resultOk = message.ok;
      }
    });
    void own(
      new Promise<void>((resolve) => {
        child.once("close", (code, signal) => {
          row.closed = true;
          row.code = code;
          row.signal = signal;
          resolve();
        });
      }),
    );
  };
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;" || sql === "PRAGMA integrity_check('sqlite_schema');") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          parentChecks += 1;
          return all();
        };
      }
      return statement;
    };
    return database;
  });
  vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
    if (args[0] !== databasePath) {
      return await realIntegrity(...args);
    }
    admissions += 1;
    let check: Promise<void>;
    forkingIntegrity = true;
    try {
      check = realIntegrity(...args);
    } finally {
      forkingIntegrity = false;
    }
    entered.resolve();
    try {
      await Promise.all([check, release.promise]);
    } finally {
      settled += 1;
    }
  });
  return {
    release,
    async expectPending(operation: Promise<unknown>) {
      expect(
        await Promise.race([
          entered.promise.then(() => "child"),
          operation.then(
            () => "completed",
            () => "failed",
          ),
        ]),
      ).toBe("child");
    },
    expectHealthy(count: number) {
      expect(parentChecks, "integrity ran on the caller thread").toBe(0);
      expect(admissions).toBe(count);
      expect(settled).toBe(count);
      expect(children.length).toBeGreaterThanOrEqual(count);
      expect(children.length).toBeLessThanOrEqual(count * 4);
      for (const child of children) {
        expect(child).toEqual({
          closed: true,
          code: 0,
          signal: null,
          resultOk: true,
          phases: ["opening", "checking", "closing"],
        });
      }
    },
  };
}

export function observePreparedWorkerAdmission({
  databasePath,
  mode,
  hooks,
  releases,
  expectParentHealthy,
}: Omit<PreparedAdmissionContext, "own"> & {
  databasePath: string;
  mode: "warm" | "cold";
  expectParentHealthy: () => void;
}) {
  const entered = createDeferred<PreparedIntegrityOwner>();
  const counts = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const resume = () => {
    Atomics.store(new Int32Array(release), 0, 1);
    Atomics.notify(new Int32Array(release), 0);
  };
  releases.push(resume);
  if (mode === "warm") {
    resume();
  }
  hooks.integrityChecks = counts;
  hooks.integrityRelease = release;
  hooks.integrityFirstCheck =
    mode === "cold" ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) : undefined;
  hooks.integrityPath = databasePath;
  const workers: Worker[] = [];
  const checking = { executor: 0, reclamation: 0, other: 0 };
  const checked = { executor: 0, reclamation: 0, other: 0 };
  let heldWorker: Worker | undefined;
  let heldCompleted = false;
  hooks.worker = (worker, owner) => {
    if (owner === "reclamation") {
      workers.push(worker);
    }
  };
  hooks.integrityPhase = (worker, owner, phase, held) => {
    if (phase === "checking") {
      checking[owner] += 1;
      if (held) {
        // The atomic claimant, not cross-worker message order, identifies the held check.
        heldWorker = worker;
        entered.resolve(owner);
      }
    } else {
      checked[owner] += 1;
      if (held) {
        heldCompleted = worker === heldWorker;
      }
    }
  };
  return {
    release: { resolve: resume },
    async expectPending(operation: Promise<unknown>) {
      const outcome = await Promise.race([
        entered.promise.then((owner) => ({ kind: "held" as const, owner })),
        operation.then(
          () => ({ kind: "completed" as const }),
          () => ({ kind: "failed" as const }),
        ),
      ]);
      if (outcome.kind !== "held") {
        throw new Error(`Maintenance ${outcome.kind} before a native integrity check was held`);
      }
      return outcome.owner;
    },
    async expectHealthy(expected: Record<PreparedIntegrityOwner, number>) {
      expectParentHealthy();
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      expect(checking).toEqual(expected);
      expect(checked).toEqual(expected);
      expect(Atomics.load(new Int32Array(counts), 0)).toBe(
        expected.executor + expected.reclamation + expected.other,
      );
      expect(heldCompleted).toBe(mode === "cold");
      expect(workers.length).toBeGreaterThan(0);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
    },
  };
}

export function observeRetainedMaintenanceFinalizer(databasePath: string) {
  const finalizers: Array<{
    database: OpenClawAgentReadOnlyDatabase | undefined;
    current: boolean;
    open: boolean;
    expired: boolean;
  }> = [];
  let preparations = 0;
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertCurrent, signal) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          const prepare = worker.prepare.bind(worker);
          const execute = worker.run.bind(worker);
          const prepareSpy = vi.spyOn(worker, "prepare").mockImplementation((params) => {
            preparations += 1;
            return prepare(params);
          });
          const runSpy = vi.spyOn(worker, "run").mockImplementation((params) => {
            if (
              params.plan.databaseOptions.path === databasePath &&
              params.plan.kind === "maintenance-finalize"
            ) {
              const owner = params.validationOwner;
              const retained = owner && "database" in owner ? owner : undefined;
              finalizers.push({
                database: retained?.database,
                current: retained?.isCurrent() ?? false,
                open: retained?.database.db.isOpen ?? false,
                expired:
                  retained !== undefined &&
                  getOpenClawAgentDatabaseValidation(retained.database) === undefined,
              });
            }
            return execute(params);
          });
          try {
            return await run(worker);
          } finally {
            prepareSpy.mockRestore();
            runSpy.mockRestore();
          }
        },
        assertCurrent,
        signal,
      ),
  );
  return {
    expectExpired(database: OpenClawAgentDatabase) {
      expect(preparations, "retained finalization must not use cold preparation").toBe(0);
      expect(finalizers).toHaveLength(1);
      expect(finalizers[0]?.database).toBe(database);
      expect(finalizers[0]).toMatchObject({ current: true, open: true, expired: true });
    },
  };
}
