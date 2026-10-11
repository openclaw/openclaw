import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
}));

// The journal read transport stands in for state-read workers so the
// fixture can observe admission concurrency without spawning real workers.
// mock-isolation: the real state-read worker transport must stay unmocked at the export level; this fixture intercepts only the journal read entry point.
vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => {
    journalReadState.calls += 1;
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
    return "absent";
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
