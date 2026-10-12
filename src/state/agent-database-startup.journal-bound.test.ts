import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";

// Mirrors AGENT_DATABASE_STARTUP_JOURNAL_CONCURRENCY; a literal keeps the bound pinned
// even if the constant is renamed or removed.
const EXPECTED_MAX_CONCURRENT_JOURNAL_READS = 8;

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);

const journalReadState = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: 0,
  opened: false,
  gates: [] as Array<() => void>,
  capacityRejectsRemaining: 0,
  nextStatus: "absent" as "absent" | "pending",
  holdReads: true,
}));

// The journal read transport stands in for state-read workers so the
// fixture can observe admission concurrency without spawning real workers.
// mock-isolation: the real state-read worker transport must stay unmocked at the export level; this fixture intercepts only the journal read entry point.
vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => {
    journalReadState.calls += 1;
    // A shared-pool admission rejection happens before the read runs, so the
    // rejected call never occupies a read slot.
    if (journalReadState.capacityRejectsRemaining > 0) {
      journalReadState.capacityRejectsRemaining -= 1;
      throw new WorkerTaskError("worker task capacity reached", "overloaded");
    }
    if (!journalReadState.holdReads) {
      return journalReadState.nextStatus;
    }
    journalReadState.active += 1;
    journalReadState.maxActive = Math.max(journalReadState.maxActive, journalReadState.active);
    // Hold each admitted read on a deferred gate so concurrent admissions overlap;
    // once the bound is first saturated the gate opens for good, keeping the
    // overlap deterministic instead of paying real timer delays.
    if (journalReadState.active >= EXPECTED_MAX_CONCURRENT_JOURNAL_READS) {
      journalReadState.opened = true;
      for (const release of journalReadState.gates.splice(0)) {
        release();
      }
    }
    await new Promise<void>((resolve) => {
      if (journalReadState.opened) {
        resolve();
        return;
      }
      journalReadState.gates.push(resolve);
    });
    journalReadState.active -= 1;
    return journalReadState.nextStatus;
  }),
}));

const admissionState = vi.hoisted(() => ({ failed: [] as string[], prepared: [] as string[] }));

vi.mock("./agent-database-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-database-admission.js")>();
  return {
    ...actual,
    preparePendingAgentDatabase: vi.fn(async (_refusal, _options, run) => {
      await run();
      admissionState.prepared.push(_refusal.agentId);
    }),
    failPendingAgentDatabase: vi.fn((refusal: { agentId: string }) => {
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

const AGENT_COUNT = 64;

beforeEach(() => {
  journalReadState.active = 0;
  journalReadState.maxActive = 0;
  journalReadState.calls = 0;
  journalReadState.opened = false;
  journalReadState.gates = [];
  journalReadState.capacityRejectsRemaining = 0;
  journalReadState.nextStatus = "absent";
  journalReadState.holdReads = true;
  admissionState.failed = [];
  admissionState.prepared = [];
});

it("bounds startup deletion-journal reads below the state-read pool's pending-task admission", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-bound-") };
  const sharedPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(sharedPath, "");
  const inspections = Array.from({ length: AGENT_COUNT }, (_, index) => ({
    target: { agentId: `agent-${index}`, path: sharedPath },
    result: Promise.resolve({ incompatible: [], indeterminate: [] }) as never,
  }));
  await withAgentDatabaseStartupAdmission(async (admission) => {
    admission.adopt();
    const refusals = admission.defer({
      env,
      inspections,
      reason: "startup journal bound regression",
    });
    expect(refusals).toHaveLength(AGENT_COUNT);
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    await admission.pendingPreparation;
    // Every deferred healthy agent prepared exactly once, with the pre-prepare and
    // post-publication journal checks; none was failed as degraded.
    expect(admissionState.prepared).toHaveLength(AGENT_COUNT);
    expect(admissionState.failed).toEqual([]);
    expect(journalReadState.calls).toBe(AGENT_COUNT * 2);
    // The fan-out must stay far below the pool's 128-pending-task admission so a
    // transient capacity rejection can never fail an otherwise-healthy agent; the
    // gate only opens once the reads actually saturate the permitted bound.
    expect(journalReadState.maxActive).toBe(EXPECTED_MAX_CONCURRENT_JOURNAL_READS);
  });
});

it("retries a shared-pool capacity rejection instead of failing the agent", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-capacity-retry-") };
  const sharedPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(sharedPath, "");
  journalReadState.holdReads = false;
  journalReadState.capacityRejectsRemaining = 2;
  const inspections = Array.from({ length: 3 }, (_, index) => ({
    target: { agentId: `agent-${index}`, path: sharedPath },
    result: Promise.resolve({ incompatible: [], indeterminate: [] }) as never,
  }));
  await withAgentDatabaseStartupAdmission(async (admission) => {
    admission.adopt();
    const refusals = admission.defer({
      env,
      inspections,
      reason: "startup journal capacity retry",
    });
    expect(refusals).toHaveLength(3);
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    await admission.pendingPreparation;
    // Cross-traffic that saturates the shared pool can still reject journal
    // reads at admission; the typed transient overload retries with backoff so
    // every healthy agent prepares and none is marked degraded.
    expect(admissionState.prepared).toHaveLength(3);
    expect(admissionState.failed).toEqual([]);
    // 3 agents × 2 checks + 2 retried capacity rejections.
    expect(journalReadState.calls).toBe(8);
  });
});

it("treats a deletion-journal tombstone as terminal instead of retrying it", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-tombstone-") };
  const sharedPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(sharedPath, "");
  journalReadState.holdReads = false;
  journalReadState.nextStatus = "pending";
  const inspections = [
    {
      target: { agentId: "agent-tombstoned", path: sharedPath },
      result: Promise.resolve({ incompatible: [], indeterminate: [] }) as never,
    },
  ];
  await withAgentDatabaseStartupAdmission(async (admission) => {
    admission.adopt();
    const refusals = admission.defer({
      env,
      inspections,
      reason: "startup journal tombstone",
    });
    expect(refusals).toHaveLength(1);
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    await admission.pendingPreparation;
    // A tombstone verdict observes a deletion, not a capacity error: it fails
    // the agent immediately without a single retry.
    expect(admissionState.failed).toEqual(["agent-tombstoned"]);
    expect(admissionState.prepared).toEqual([]);
    expect(journalReadState.calls).toBe(1);
  });
});

it("surfaces the typed overload as degraded once the bounded retry is exhausted", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirTracker.make("journal-capacity-exhausted-") };
  const sharedPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.writeFileSync(sharedPath, "");
  journalReadState.holdReads = false;
  journalReadState.capacityRejectsRemaining = 99;
  const inspections = [
    {
      target: { agentId: "agent-0", path: sharedPath },
      result: Promise.resolve({ incompatible: [], indeterminate: [] }) as never,
    },
  ];
  await withAgentDatabaseStartupAdmission(async (admission) => {
    admission.adopt();
    const refusals = admission.defer({
      env,
      inspections,
      reason: "startup journal capacity exhaustion",
    });
    expect(refusals).toHaveLength(1);
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    await admission.pendingPreparation;
    // The retry is bounded: an overload outlasting every attempt still
    // surfaces through the existing permanent degraded refusal.
    expect(admissionState.failed).toEqual(["agent-0"]);
    expect(admissionState.prepared).toEqual([]);
  });
});
