import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerError, wrapSqliteWorkerError } from "../infra/sqlite-worker-error.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabaseSchemaAdmissionChangedError as ChangedAdmission,
  AgentDatabaseSchemaAdmissionInvalidError as InvalidAdmission,
} from "./agent-database-admission-error.js";
import {
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  recordAgentDatabaseAdmissions,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
const admissionState = vi.hoisted(() => ({ failed: [] as string[], prepared: [] as string[] }));

// mock-isolation: replace only the journal transport to model bounded worker admission without starting workers.
vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(),
}));

vi.mock("./agent-database-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-database-admission.js")>();
  return {
    ...actual,
    preparePendingAgentDatabase: vi.fn<typeof actual.preparePendingAgentDatabase>(
      async (refusal, options, run) => {
        await actual.preparePendingAgentDatabase(refusal, options, run);
        admissionState.prepared.push(refusal.agentId);
      },
    ),
    failPendingAgentDatabase: vi.fn<typeof actual.failPendingAgentDatabase>(
      (refusal, cause, options) => {
        const previous = actual.listAgentDatabaseAdmissionRefusals(options);
        actual.failPendingAgentDatabase(refusal, cause, options);
        // Observe recorded verdicts; repeating an already-recorded refusal is idempotent.
        if (
          actual
            .listAgentDatabaseAdmissionRefusals(options)
            .some((entry) => !previous.includes(entry))
        ) {
          admissionState.failed.push(refusal.agentId);
        }
      },
    ),
  };
});

vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>();
  return {
    ...actual,
    withSqliteReadOnlyWorkerScope: async (operation: () => Promise<unknown>) => operation(),
  };
});

const readJournal = vi.mocked(readAgentDeletionJournalStatusInWorker);
const overload = () => new WorkerTaskError("worker task capacity reached", "overloaded");
const locked = () => Object.assign(new Error("locked"), { errcode: 5 });
function expectAdmission(prepared: string[], failed: string[], reads: number) {
  expect(admissionState).toEqual({ prepared, failed });
  expect(readJournal).toHaveBeenCalledTimes(reads);
}

beforeEach(() => {
  vi.useFakeTimers();
  readJournal.mockReset().mockResolvedValue("absent");
  admissionState.failed = [];
  admissionState.prepared = [];
});

afterEach(() => vi.useRealTimers());

async function prepareAgents(
  count: number,
  options: {
    isCurrent?: () => boolean;
    openAgent?: () => Promise<AsyncDisposable | void>;
    migrateAgent?: () => Promise<void>;
    publishAgent?: () => Promise<void>;
    afterActivation?: () => Promise<void>;
    inspection?: OpenClawDatabaseSchemaPreflight;
  } = {},
) {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-bound-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(pathname, "");
  const agentIds = Array.from({ length: count }, (_, index) => `agent-${index}`);
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const lifetime = admission.adopt();
    try {
      const refusals = admission.defer({
        env,
        inspections: agentIds.map((agentId) => ({
          target: { agentId, path: pathname },
          result: Promise.resolve(options.inspection ?? { incompatible: [], indeterminate: [] }),
        })),
        reason: "startup journal admission regression",
      });
      recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
      admission.activate({
        isCurrent: options.isCurrent ?? (() => true),
        preparationReady: Promise.resolve(),
        openAgent: options.openAgent ?? (async () => {}),
        migrateAgent: options.migrateAgent ?? (async () => {}),
        publishAgent: options.publishAgent ?? (async () => {}),
      });
      await options.afterActivation?.();
      // Four attempts, including jitter, finish before the progress interval fires.
      await vi.advanceTimersByTimeAsync(10_000);
      await admission.pendingPreparation;
      for (const agentId of admissionState.prepared) {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
      }
    } finally {
      await lifetime.stop();
    }
  });
  return agentIds;
}

it.each([undefined, "migration", "publication"] as const)(
  "retains the prepared resource until startup settles (%s)",
  async (failure) => {
    const events: string[] = [];
    let released = false;
    const step = async (phase: string) => {
      expect(released).toBe(false);
      events.push(phase);
      if (phase === failure) {
        throw new Error("startup fixture refusal");
      }
    };
    await prepareAgents(1, {
      openAgent: async () => ({
        async [Symbol.asyncDispose]() {
          released = true;
          events.push("released");
        },
      }),
      migrateAgent: () => step("migration"),
      publishAgent: () => step("publication"),
    });
    expect(events).toEqual(
      failure === "migration"
        ? ["migration", "released"]
        : ["migration", "publication", "released"],
    );
    expect(admissionState.failed).toEqual(failure ? ["agent-0"] : []);
  },
);

it("prepares more than 128 agents without overflowing state-read admission", async () => {
  let active = 0;
  let maxActive = 0;
  readJournal.mockImplementation(async () => {
    if (active >= 128) {
      throw overload();
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      // Every read in one admission burst overlaps until the next microtask.
      await Promise.resolve();
      return "absent";
    } finally {
      active -= 1;
    }
  });
  const agents = await prepareAgents(140);
  expect(admissionState.prepared.toSorted()).toEqual(agents.toSorted());
  expect(admissionState.failed).toEqual([]);
  expect(readJournal).toHaveBeenCalledTimes(280);
  expect(maxActive).toBeLessThanOrEqual(8);
});

it.each([
  ["migrateAgent", Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }), 4, 4],
  ["migrateAgent", new AggregateError([locked(), new Error("cleanup failed")]), 1, 1],
  ["migrateAgent", overload(), 4, 4],
  ["migrateAgent", new SqliteWorkerError("capacity reached", "overloaded"), 4, 4],
  ["migrateAgent", new SqliteWorkerError("unknown settlement", "outcome-unknown"), 1, 1],
  [
    "migrateAgent",
    wrapSqliteWorkerError(
      "capacity reached",
      "overloaded",
      new SqliteWorkerError("unknown settlement", "outcome-unknown"),
    ),
    1,
    1,
  ],
  ["publishAgent", new ChangedAdmission(), 4, 4],
  ["publishAgent", new InvalidAdmission(), 1, 1],
] as const)("refuses %s for %s after %i attempts", async (operation, error, attempts, reads) => {
  const run = vi.fn().mockRejectedValue(error);
  await prepareAgents(1, { [operation]: run });
  expectAdmission([], ["agent-0"], reads);
  expect(run).toHaveBeenCalledTimes(attempts);
});

it("retries shared-pool capacity rejections and prepares the agent", async () => {
  readJournal.mockRejectedValueOnce(overload()).mockRejectedValueOnce(overload());
  await prepareAgents(1);
  expectAdmission(["agent-0"], [], 4);
});

it.each([
  ["openAgent", locked()],
  ["migrateAgent", locked()],
  ["openAgent", overload()],
  ["migrateAgent", overload()],
  ["migrateAgent", new SqliteWorkerError("capacity reached", "overloaded")],
  ["publishAgent", overload()],
] as const)("recovers a transient failure in %s: %s", async (operation, error) => {
  const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const opened = vi.fn().mockResolvedValue(undefined);
  await prepareAgents(1, { openAgent: opened, [operation]: run });
  expectAdmission(["agent-0"], [], 3);
  expect(run).toHaveBeenCalledTimes(2);
  if (operation === "migrateAgent") {
    expect(opened).toHaveBeenCalledOnce();
  }
});

it("preserves preflight overload guidance when deferred inspection fails", async () => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "agent-0",
    paths: [],
    reason: "worker capacity reached",
    cause: overload(),
  });
  await prepareAgents(1, {
    inspection: { incompatible: [], indeterminate: [], agentRefusals: [refusal] },
  });
  const options = vi.mocked(failPendingAgentDatabase).mock.lastCall![2];
  const recorded = readAgentDatabaseAdmissionRefusal("agent-0", options);
  expect(recorded?.repairHint).toContain("restart the Gateway");
  expect(recorded?.repairHint).not.toContain("doctor --fix");
});

it.each(["deletion", "replacement"] as const)(
  "refuses %s before retrying a locked migration",
  async (change) => {
    const run = vi.fn().mockRejectedValue(locked());
    readJournal.mockImplementation(async (_agentId, options) => {
      const env = options?.env;
      if (readJournal.mock.calls.length === 2) {
        if (change === "deletion") {
          return "pending";
        }
        const pathname = path.join(env!.OPENCLAW_STATE_DIR!, "openclaw-agent.sqlite");
        fs.renameSync(pathname, `${pathname}.previous`);
        fs.writeFileSync(pathname, "replacement");
      }
      return "absent";
    });
    await prepareAgents(1, { migrateAgent: run });
    expectAdmission([], ["agent-0"], 2);
    expect(run).toHaveBeenCalledOnce();
  },
);

it("keeps real database corruption terminal during migration", async () => {
  const pathname = path.join(tempDirTracker.make("corrupt-startup-"), "corrupt.sqlite");
  fs.writeFileSync(pathname, "This is not a SQLite database".repeat(100));
  const migrateAgent = vi.fn(async () => {
    using database = new DatabaseSync(pathname);
    database.prepare("PRAGMA schema_version").get();
  });
  await prepareAgents(1, { migrateAgent });
  expect(migrateAgent).toHaveBeenCalledOnce();
  expectAdmission([], ["agent-0"], 1);
});

it("does not republish after the agent is deleted during an admission retry", async () => {
  readJournal.mockResolvedValueOnce("absent").mockResolvedValue("pending");
  const publish = vi.fn().mockRejectedValue(new ChangedAdmission());
  await prepareAgents(1, { publishAgent: publish });
  expect(publish).toHaveBeenCalledOnce();
  expect(admissionState).toEqual({ prepared: [], failed: ["agent-0"] });
});

it.each([
  ["pending", 1],
  ["complete", 1],
  [new Error("journal unreadable"), 1],
  [overload(), 4],
] as const)("refuses startup for %s after %i reads", async (outcome, attempts) => {
  if (outcome instanceof Error) {
    readJournal.mockRejectedValue(outcome);
  } else {
    readJournal.mockResolvedValue(outcome);
  }
  await prepareAgents(1);
  expectAdmission([], ["agent-0"], attempts);
  if (typeof outcome === "string") {
    const options = vi.mocked(failPendingAgentDatabase).mock.lastCall![2];
    const refusal = readAgentDatabaseAdmissionRefusal("agent-0", options);
    expect(refusal?.repairHint).toContain("retry agents.delete");
    expect(refusal?.repairHint).not.toContain("doctor --fix");
  }
});

it("does not start queued journal reads after Gateway ownership changes", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let current = true;
  readJournal.mockImplementation(async () => {
    if (readJournal.mock.calls.length === 8) {
      entered.resolve();
    }
    await release.promise;
    return "absent";
  });
  await prepareAgents(9, {
    isCurrent: () => current,
    afterActivation: async () => {
      await entered.promise;
      current = false;
      release.resolve();
    },
  });
  expect(readJournal).toHaveBeenCalledTimes(8);
  expect(admissionState.prepared).toEqual([]);
  expect(admissionState.failed).toHaveLength(9);
});
