import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import { applySessionEntryReplacements } from "./session-accessor.sqlite-projection.js";
import {
  createFixture,
  leasesFor,
  observeReclamationWorkers,
  tempDirs,
} from "./session-accessor.sqlite-reclamation-reuse.test-support.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.types.js";

const integrity = vi.hoisted(() => ({
  counts: undefined as SharedArrayBuffer | undefined,
  release: undefined as SharedArrayBuffer | undefined,
  entered: undefined as (() => void) | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly observeIntegrity: (() => void) | undefined;

      constructor(filename: string | URL, options?: WorkerOptions) {
        const data: unknown = options?.workerData;
        const reclaimer = isRecord(data) && data.operation === "reclaim";
        super(
          filename,
          reclaimer
            ? withWorkerSqliteIntegrityCounter(options, integrity.counts, integrity.release)
            : options,
        );
        this.observeIntegrity = reclaimer ? integrity.entered : undefined;
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (
          this.observeIntegrity &&
          event === "message" &&
          args.length === 1 &&
          isRecord(message) &&
          Object.keys(message).length === 2 &&
          message.type === "test-integrity-check" &&
          (message.phase === "checking" || message.phase === "checked")
        ) {
          if (message.phase === "checking") {
            this.observeIntegrity();
          }
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

afterEach(async () => {
  integrity.counts = undefined;
  integrity.release = undefined;
  integrity.entered = undefined;
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

test("commits foreground replacement while cold reclamation holds native integrity", async () => {
  const fixture = createFixture(["victim", "foreground"]);
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.options.env.OPENCLAW_STATE_DIR);
  await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
  invalidateOpenClawAgentDatabaseValidation(fixture.database.path);
  revokeSqliteDatabaseAdmissionsForPath(fixture.database.path);
  const entered = createDeferredCore();
  const counts = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  integrity.counts = counts;
  integrity.release = release;
  integrity.entered = () => entered.resolve();
  const spawned = observeReclamationWorkers();
  const work = runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => "native integrity"),
        work.then(
          () => "completed",
          () => "failed",
        ),
      ]),
    ).toBe("native integrity");
    expect(Atomics.load(new Int32Array(counts), 0)).toBe(1);
    await applySessionEntryReplacements({
      storePath: fixture.database.path,
      sessionKeys: [fixture.scopes[1]!.sessionKey],
      skipMaintenance: true,
      update: (entries) => ({
        result: undefined,
        replacements: entries.map(({ entry, sessionKey }) => {
          if (!entry) {
            throw new Error("Foreground fixture entry disappeared");
          }
          return { sessionKey, entry: { ...entry, label: "foreground committed" } };
        }),
      }),
    });
    expect(loadSessionEntryReadOnly(fixture.scopes[1]!)).toMatchObject({
      sessionId: "foreground",
      label: "foreground committed",
    });
    expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "victim" });
    expect(settled).toBe(false);
    Atomics.store(new Int32Array(release), 0, 1);
    Atomics.notify(new Int32Array(release), 0);
    await expect(work).resolves.toMatchObject({
      kind: "lifecycle-artifacts",
      value: { removedEntries: 1 },
    });
    expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toBeUndefined();
    expect(loadSessionEntryReadOnly(fixture.scopes[1]!)).toMatchObject({
      sessionId: "foreground",
      label: "foreground committed",
    });
  } finally {
    Atomics.store(new Int32Array(release), 0, 1);
    Atomics.notify(new Int32Array(release), 0);
    await Promise.allSettled([work]);
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
  }
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.threadId).toBe(-1);
  expect(leasesFor(fixture)).toHaveLength(0);
});

test.each(["caller refusal", "source retirement"] as const)(
  "preserves cold native lease custody before preparation acceptance after %s",
  async (failure) => {
    const fixture = createFixture(["victim"]);
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    let allowed = true;
    let receivedLease = false;
    let closing: Promise<unknown> | undefined;
    const spawned = observeReclamationWorkers((worker) => {
      worker.on("message", (message: SqliteReclamationWorkerMessage) => {
        if (message.type !== "lease" || receivedLease) {
          return;
        }
        receivedLease = true;
        if (failure === "caller refusal") {
          allowed = false;
        } else {
          closing = closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
          void closing.catch(() => {});
        }
      });
    });
    const run = () =>
      runSqliteSessionReclamation({
        forceInProcess: false,
        plan: fixture.plans[0]!,
        assertCommitAllowed: () => {
          if (!allowed) {
            throw new Error("cold caller permission revoked");
          }
        },
      });
    try {
      await expect(run()).rejects.toThrow(
        failure === "caller refusal" ? "cold caller permission revoked" : /revoked|closed/,
      );
      expect(receivedLease).toBe(true);
      expect(spawned).toHaveLength(1);
      if (failure === "source retirement") {
        expect(closing).toBeDefined();
        await closing;
        expect(spawned[0]!.threadId).toBe(-1);
        expect(leasesFor(fixture)).toHaveLength(0);
      } else {
        expect(spawned[0]!.threadId).toBeGreaterThan(0);
        expect(leasesFor(fixture)).toHaveLength(1);
      }
      expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "victim" });
      if (failure === "caller refusal") {
        allowed = true;
        await expect(run()).resolves.toMatchObject({
          kind: "lifecycle-artifacts",
          value: { removedEntries: 1 },
        });
        expect(spawned).toHaveLength(1);
        expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toBeUndefined();
      }
    } finally {
      await closing;
      await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    }
    expect(spawned[0]!.threadId).toBe(-1);
    expect(leasesFor(fixture)).toHaveLength(0);
  },
);
