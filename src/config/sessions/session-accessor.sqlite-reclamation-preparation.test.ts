import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
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
import { createWorkerSqliteIntegrityGate } from "./session-accessor.sqlite-integrity-counter.test-support.js";
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
  gate: undefined as ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
}));
const removedOne = { kind: "lifecycle-artifacts", value: { removedEntries: 1 } };
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly gate: typeof integrity.gate;

      constructor(filename: string | URL, options?: WorkerOptions) {
        const data: unknown = options?.workerData;
        const gate = isRecord(data) && data.operation === "reclaim" ? integrity.gate : undefined;
        super(filename, gate?.options(options) ?? options);
        this.gate = gate;
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (event === "message" && this.gate?.message(this, args[0])) {
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

afterEach(async () => {
  integrity.gate = undefined;
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
  const read = (index: number) => loadSessionEntryReadOnly(fixture.scopes[index]!);
  const foreground = { sessionId: "foreground", label: "foreground committed" };
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.options.env.OPENCLAW_STATE_DIR);
  await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
  invalidateOpenClawAgentDatabaseValidation(fixture.database.path);
  revokeSqliteDatabaseAdmissionsForPath(fixture.database.path);
  const gate = createWorkerSqliteIntegrityGate(fixture.database.path);
  gate.arm();
  integrity.gate = gate;
  const spawned = observeReclamationWorkers();
  const work = runSqliteSessionReclamation({ plan: fixture.plans[0]! });
  const settled = vi.fn();
  void work.then(settled, settled);
  try {
    expect(await Promise.race([gate.entered.then(() => "native integrity"), work])).toBe(
      "native integrity",
    );
    expect(gate.count()).toBe(1);
    await applySessionEntryReplacements({
      storePath: fixture.database.path,
      sessionKeys: [fixture.scopes[1]!.sessionKey],
      skipMaintenance: true,
      update: (entries) => ({
        result: undefined,
        replacements: entries.map(({ entry, sessionKey }) => ({
          sessionKey,
          entry: { ...entry, label: "foreground committed" },
        })),
      }),
    });
    expect(read(1)).toMatchObject(foreground);
    expect(read(0)).toMatchObject({ sessionId: "victim" });
    expect(settled).not.toHaveBeenCalled();
    gate.release();
    await expect(work).resolves.toMatchObject(removedOne);
    expect(read(0)).toBeUndefined();
    expect(read(1)).toMatchObject(foreground);
  } finally {
    gate.release();
    await Promise.allSettled([work]);
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
  }
  expect([spawned.map((worker) => worker.threadId), leasesFor(fixture)]).toEqual([[-1], []]);
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
      if (failure === "source retirement") {
        await closing;
        expect([spawned.map((worker) => worker.threadId), leasesFor(fixture)]).toEqual([[-1], []]);
      } else {
        expect(spawned[0]!.threadId).toBeGreaterThan(0);
        expect(leasesFor(fixture)).toHaveLength(1);
      }
      expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "victim" });
      if (failure === "caller refusal") {
        allowed = true;
        await expect(run()).resolves.toMatchObject(removedOne);
        expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toBeUndefined();
      }
    } finally {
      await closing;
      await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    }
    expect([spawned.map((worker) => worker.threadId), leasesFor(fixture)]).toEqual([[-1], []]);
  },
);
