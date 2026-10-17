import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { initializeSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import { SqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { FixtureOperations } from "../infra/sqlite-worker-store.test-support.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
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
    }) => Promise<void>;
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
  expect(admissionState.prepared).toEqual(["agent-0"]);
  expect(admissionState.failed).toEqual([]);
  expect(readJournal).toHaveBeenCalledTimes(4);
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

it.each(["pending", "complete"] as const)(
  "does not retry a %s deletion tombstone",
  async (status) => {
    readJournal.mockResolvedValue(status);
    await prepareAgents(1);
    expect(admissionState.prepared).toEqual([]);
    expect(admissionState.failed).toEqual(["agent-0"]);
    expect(readJournal).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { name: "a genuine read failure", error: new Error("journal unreadable"), attempts: 1 },
  { name: "exhausted capacity retries", error: overload(), attempts: 4 },
])("records $name as degraded", async ({ error, attempts }) => {
  readJournal.mockRejectedValue(error);
  await prepareAgents(1);
  expect(admissionState.prepared).toEqual([]);
  expect(admissionState.failed).toEqual(["agent-0"]);
  expect(readJournal).toHaveBeenCalledTimes(attempts);
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
