import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { initializeSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import { SqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { FixtureOperations } from "../infra/sqlite-worker-store.test-support.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "./openclaw-agent-db-contract.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
const admissionState = vi.hoisted(() => ({ failed: [] as string[], prepared: [] as string[] }));

// mock-isolation: control journal admission independently of SQLite store capacity.
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
      (refusal, error, options) => {
        actual.failPendingAgentDatabase(refusal, error, options);
        admissionState.failed.push(refusal.agentId);
      },
    ),
  };
});

vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>();
  return {
    ...actual,
    withSqliteReadOnlyWorkerScope: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  };
});

const readJournal = vi.mocked(readAgentDeletionJournalStatusInWorker);
const overload = () => new WorkerTaskError("worker task capacity reached", "overloaded");
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
    openAgent?: (input: {
      agentId: string;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) => Promise<AsyncDisposable | void>;
    migrateAgent?: () => Promise<void>;
    publishAgent?: () => Promise<void>;
    afterActivation?: (stop: () => Promise<void>) => Promise<void>;
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
          result: Promise.resolve({ incompatible: [], indeterminate: [] }),
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
      await options.afterActivation?.(() => lifetime.stop());
      // Four attempts, including jitter, finish before the progress interval fires.
      await vi.advanceTimersByTimeAsync(10_000);
      await admission.pendingPreparation;
    } finally {
      await lifetime.stop();
      recordAgentDatabaseAdmissions([], { env, source: "startup" });
    }
  });
  return agentIds;
}

it.each([
  { failure: undefined, retry: false },
  { failure: "migration", retry: false },
  { failure: "publication", retry: false },
  { failure: undefined, retry: true },
  { failure: "publication", retry: true },
] as const)(
  "retains the prepared resource until startup settles ($failure, retry=$retry)",
  async ({ failure, retry }) => {
    const events: string[] = [];
    let released = false;
    const step = async (phase: string) => {
      expect(released).toBe(false);
      events.push(phase);
      if (phase === failure) {
        throw new Error("startup fixture refusal");
      }
    };
    const open = vi.fn(async () => ({
      async [Symbol.asyncDispose]() {
        released = true;
        events.push("released");
      },
    }));
    if (retry) {
      open.mockRejectedValueOnce(
        new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
      );
    }
    await prepareAgents(1, {
      openAgent: open,
      migrateAgent: () => step("migration"),
      publishAgent: () => step("publication"),
    });
    expect(events).toEqual(
      failure === "migration"
        ? ["migration", "released"]
        : ["migration", "publication", "released"],
    );
    expect(admissionState.failed).toEqual(failure ? ["agent-0"] : []);
    expect(open).toHaveBeenCalledTimes(retry ? 2 : 1);
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

it("retries shared-pool capacity rejections and prepares the agent", async () => {
  readJournal.mockRejectedValueOnce(overload()).mockRejectedValueOnce(overload());
  await prepareAgents(1);
  expectAdmission(["agent-0"], [], 4);
});

it("publishes startup preparation after a busy SQLite broker releases capacity", async () => {
  await initializeSqliteRuntimeCapabilities();
  const broker = new SqliteWorkerBroker();
  const options = {
    moduleUrl: new URL("../infra/sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: path.join(tempDirTracker.make("startup-capacity-"), "store.sqlite"),
    input: undefined,
  };
  const capacityRejected = createDeferredCore<unknown>();
  const publish = vi.fn(async () => {});
  const held: {
    store: SqliteWorkerStore<FixtureOperations>;
    release: Deferred;
    operation: Promise<void>;
  }[] = [];
  const database = openNodeSqliteDatabase(options.databasePath);
  database.close();
  try {
    for (let index = 0; index < 64; index++) {
      const store: SqliteWorkerStore<FixtureOperations> | undefined =
        await broker.open<FixtureOperations>(options, undefined, undefined, {
          retireIdle: () => {
            assert(store);
            return store.close();
          },
        });
      assert(store);
      const release = createDeferredCore();
      const operation = broker.runOperation(store, () => release.promise);
      held.push({ store, release, operation });
    }
    await prepareAgents(1, {
      openAgent: async ({ signal, assertCurrent }) => {
        try {
          const store = await broker.open<FixtureOperations>(options, undefined, assertCurrent, {
            signal,
          });
          await store?.close();
        } catch (error) {
          capacityRejected.resolve(error);
          throw error;
        }
      },
      publishAgent: publish,
      afterActivation: async () => {
        expect(await capacityRejected.promise).toMatchObject({
          name: "SqliteWorkerError",
          code: "overloaded",
        });
        const available = held.pop();
        assert(available);
        available.release.resolve();
        await available.operation;
        await available.store.close();
      },
    });
    expect(admissionState.prepared).toEqual(["agent-0"]);
    expect(admissionState.failed).toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    for (const { release } of held) {
      release.resolve();
    }
    await Promise.all(held.map(({ operation }) => operation));
    await broker.close();
  }
});

it("lets other agents prepare during backoff without repeating migration or publication", async () => {
  const count = AGENT_DATABASE_PREFLIGHT_CONCURRENCY + 1;
  const opened = new Set<string>();
  const migrate = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  await prepareAgents(count, {
    openAgent: async ({ agentId }) => {
      if (!opened.has(agentId)) {
        opened.add(agentId);
        throw new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
      }
    },
    migrateAgent: migrate,
    publishAgent: publish,
    afterActivation: async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(opened.size).toBe(count);
    },
  });
  expect(admissionState.prepared).toHaveLength(count);
  expect(admissionState.failed).toEqual([]);
  expect(migrate).toHaveBeenCalledTimes(count);
  expect(publish).toHaveBeenCalledTimes(count);
});

it.each([
  {
    name: "exhausted broker capacity",
    error: new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
    attempts: 4,
  },
  { name: "a genuine open failure", error: new Error("database unreadable"), attempts: 1 },
  {
    name: "a closing broker",
    error: new SqliteWorkerError("SQLite worker host is closing", "closed"),
    attempts: 1,
  },
  {
    name: "failed cleanup after overload",
    error: new AggregateError([
      new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
      new Error("native cleanup failed"),
    ]),
    attempts: 1,
  },
])("leaves $name degraded without unsafe retries", async ({ error, attempts }) => {
  const open = vi.fn(async () => {
    throw error;
  });
  const migrate = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  await prepareAgents(1, { openAgent: open, migrateAgent: migrate, publishAgent: publish });
  expect(open).toHaveBeenCalledTimes(attempts);
  expect(admissionState.prepared).toEqual([]);
  expect(admissionState.failed).toEqual(["agent-0"]);
  expect(migrate).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it.each(["migration", "publication"] as const)(
  "does not replay preparation after an overload during %s",
  async (phase) => {
    const error = new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
    const open = vi.fn(async () => {});
    const migrate = vi.fn(async () => {
      if (phase === "migration") {
        throw error;
      }
    });
    const publish = vi.fn(async () => {
      throw error;
    });
    await prepareAgents(1, { openAgent: open, migrateAgent: migrate, publishAgent: publish });
    expect(open).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(phase === "migration" ? 0 : 1);
    expect(admissionState.failed).toEqual(["agent-0"]);
  },
);

it.each(["shutdown", "replacement"] as const)(
  "does not reopen after Gateway %s during capacity backoff",
  async (change) => {
    const rejected = createDeferredCore();
    let current = true;
    const open = vi.fn(async () => {
      rejected.resolve();
      throw new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
    });
    const publish = vi.fn(async () => {});
    await prepareAgents(1, {
      isCurrent: () => current,
      openAgent: open,
      publishAgent: publish,
      afterActivation: async (stop) => {
        await rejected.promise;
        if (change === "shutdown") {
          await stop();
        } else {
          current = false;
        }
      },
    });
    expect(open).toHaveBeenCalledOnce();
    expect(admissionState.prepared).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  },
);

it("recovers opening capacity and publication admission without repeating migration", async () => {
  const open = vi
    .fn(async () => {})
    .mockRejectedValueOnce(
      new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
    );
  const migrate = vi.fn(async () => {});
  const publish = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new AgentDatabaseSchemaAdmissionChangedError());
  await prepareAgents(1, { openAgent: open, migrateAgent: migrate, publishAgent: publish });
  expect(admissionState).toEqual({ prepared: ["agent-0"], failed: [] });
  expect(open).toHaveBeenCalledTimes(2);
  expect(migrate).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledTimes(2);
});

it("recovers mixed opening capacity and locks without reopening during migration", async () => {
  let released = false;
  const events: string[] = [];
  const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });
  const open = vi
    .fn()
    .mockRejectedValueOnce(
      new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
    )
    .mockRejectedValueOnce(busy())
    .mockResolvedValue({
      async [Symbol.asyncDispose]() {
        released = true;
        events.push("released");
      },
    });
  const migrate = vi
    .fn()
    .mockImplementationOnce(async () => {
      expect(released).toBe(false);
      throw busy();
    })
    .mockImplementation(async () => {
      expect(released).toBe(false);
      events.push("migrated");
    });
  await prepareAgents(1, {
    openAgent: open,
    migrateAgent: migrate,
    publishAgent: async () => {
      expect(released).toBe(false);
      events.push("published");
    },
  });
  expectAdmission(["agent-0"], [], 5);
  expect(open).toHaveBeenCalledTimes(3);
  expect(migrate).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["migrated", "published", "released"]);
});

it("shares one bounded opening budget across capacity and lock failures", async () => {
  const overloaded = new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
  const locked = Object.assign(new Error("database is locked"), { errcode: 5 });
  const open = vi
    .fn()
    .mockRejectedValueOnce(overloaded)
    .mockRejectedValueOnce(locked)
    .mockRejectedValueOnce(overloaded)
    .mockRejectedValue(locked);
  const migrate = vi.fn();
  await prepareAgents(1, { openAgent: open, migrateAgent: migrate });
  expectAdmission([], ["agent-0"], 4);
  expect(open).toHaveBeenCalledTimes(4);
  expect(migrate).not.toHaveBeenCalled();
});

it.each(["openAgent", "migrateAgent"] as const)(
  "recovers a transient SQLite lock in %s without restarting",
  async (operation) => {
    const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
    const run = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(undefined);
    const opened = vi.fn().mockResolvedValue(undefined);
    await prepareAgents(1, { openAgent: opened, [operation]: run });
    expectAdmission(["agent-0"], [], 3);
    expect(run).toHaveBeenCalledTimes(2);
    if (operation === "migrateAgent") {
      expect(opened).toHaveBeenCalledOnce();
    }
  },
);

it("bounds startup lock retries and leaves the agent refused", async () => {
  const run = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }));
  await prepareAgents(1, { migrateAgent: run });
  expectAdmission([], ["agent-0"], 4);
  expect(run).toHaveBeenCalledTimes(4);
});

it.each(["deletion", "replacement"] as const)(
  "refuses %s before retrying a locked migration",
  async (change) => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("locked"), { errcode: 5 }));
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

it("does not retry a lock combined with a cleanup failure", async () => {
  const run = vi
    .fn()
    .mockRejectedValue(
      new AggregateError([
        Object.assign(new Error("locked"), { errcode: 5 }),
        new Error("cleanup failed"),
      ]),
    );
  await prepareAgents(1, { migrateAgent: run });
  expectAdmission([], ["agent-0"], 1);
  expect(run).toHaveBeenCalledOnce();
});

it("keeps real database corruption terminal during migration", async () => {
  const pathname = path.join(tempDirTracker.make("corrupt-startup-"), "corrupt.sqlite");
  fs.writeFileSync(pathname, "This is not a SQLite database".repeat(100));
  const migrateAgent = vi.fn(async () => {
    const database = new DatabaseSync(pathname);
    try {
      database.prepare("PRAGMA schema_version").get();
    } finally {
      database.close();
    }
  });
  await prepareAgents(1, { migrateAgent });
  expect(migrateAgent).toHaveBeenCalledOnce();
  expectAdmission([], ["agent-0"], 1);
});

it.each([
  [new AgentDatabaseSchemaAdmissionChangedError(), 4],
  [new AgentDatabaseSchemaAdmissionInvalidError(), 1],
] as const)("fails publication for %s after %i attempts", async (error, attempts) => {
  const publish = vi.fn().mockRejectedValue(error);
  await prepareAgents(1, { publishAgent: publish });
  expect(publish).toHaveBeenCalledTimes(attempts);
  expect(admissionState).toEqual({ prepared: [], failed: ["agent-0"] });
});

it("does not republish after the agent is deleted during an admission retry", async () => {
  readJournal.mockResolvedValueOnce("absent").mockResolvedValue("pending");
  const publish = vi.fn().mockRejectedValue(new AgentDatabaseSchemaAdmissionChangedError());
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
