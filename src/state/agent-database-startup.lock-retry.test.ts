import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
const admissionState = vi.hoisted(() => ({ failed: [] as string[], prepared: [] as string[] }));

// mock-isolation: replace only the journal transport so lock retries run without starting workers.
vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(),
}));

vi.mock("./agent-database-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-database-admission.js")>();
  return {
    ...actual,
    preparePendingAgentDatabase: vi.fn<typeof actual.preparePendingAgentDatabase>(
      async (refusal, _options, run) => {
        await run();
        admissionState.prepared.push(refusal.agentId);
      },
    ),
    failPendingAgentDatabase: vi.fn<typeof actual.failPendingAgentDatabase>((refusal) => {
      admissionState.failed.push(refusal.agentId);
    }),
    readAgentDatabaseAdmissionRefusal: vi.fn(() => undefined),
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

async function prepareAgent(options: {
  openAgent?: () => Promise<void>;
  migrateAgent?: () => Promise<void>;
}) {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("lock-retry-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(pathname, "");
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const lifetime = admission.adopt();
    try {
      admission.defer({
        env,
        inspections: [
          {
            target: { agentId: "agent-0", path: pathname },
            result: Promise.resolve({ incompatible: [], indeterminate: [] }),
          },
        ],
        reason: "startup lock retry regression",
      });
      admission.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: options.openAgent ?? (async () => {}),
        migrateAgent: options.migrateAgent ?? (async () => {}),
        publishAgent: async () => {},
      });
      // Four attempts, including jitter, finish before the progress interval fires.
      await vi.advanceTimersByTimeAsync(10_000);
      await admission.pendingPreparation;
    } finally {
      await lifetime.stop();
    }
  });
}

it.each(["openAgent", "migrateAgent"] as const)(
  "recovers a transient SQLite lock in %s without restarting",
  async (operation) => {
    const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
    const run = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(undefined);
    const opened = vi.fn().mockResolvedValue(undefined);
    await prepareAgent({ openAgent: opened, [operation]: run });
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
  await prepareAgent({ migrateAgent: run });
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
    await prepareAgent({ migrateAgent: run });
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
  await prepareAgent({ migrateAgent: run });
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
  await prepareAgent({ migrateAgent });
  expect(migrateAgent).toHaveBeenCalledOnce();
  expectAdmission([], ["agent-0"], 1);
});
