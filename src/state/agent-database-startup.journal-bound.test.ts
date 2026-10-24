import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";

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
    openAgent?: () => Promise<AsyncDisposable | void>;
    migrateAgent?: () => Promise<void>;
    publishAgent?: () => Promise<void>;
    afterActivation?: () => Promise<void>;
  } = {},
) {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-bound-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(pathname, "");
  const agentIds = Array.from({ length: count }, (_, index) => `agent-${index}`);
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const lifetime = admission.adopt();
    try {
      admission.defer({
        env,
        inspections: agentIds.map((agentId) => ({
          target: { agentId, path: pathname },
          result: Promise.resolve({ incompatible: [], indeterminate: [] }),
        })),
        reason: "startup journal admission regression",
      });
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

it("retries shared-pool capacity rejections and prepares the agent", async () => {
  readJournal.mockRejectedValueOnce(overload()).mockRejectedValueOnce(overload());
  await prepareAgents(1);
  expectAdmission(["agent-0"], [], 4);
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
