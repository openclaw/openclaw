import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";

// Mirrors AGENT_DATABASE_STARTUP_JOURNAL_CONCURRENCY; a literal keeps the bound pinned
// even if the constant is renamed or removed.
const EXPECTED_MAX_CONCURRENT_JOURNAL_READS = 8;

const journalReadState = vi.hoisted(() => ({ active: 0, maxActive: 0, calls: 0 }));

vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => {
    journalReadState.calls += 1;
    journalReadState.active += 1;
    journalReadState.maxActive = Math.max(journalReadState.maxActive, journalReadState.active);
    // Hold the read across a macrotask so every admitted read overlaps.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
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
  admissionState.failed = [];
  admissionState.prepared = [];
});

it("bounds startup deletion-journal reads below the state-read pool's pending-task admission", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "journal-bound-")) };
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
    // transient capacity rejection can never fail an otherwise-healthy agent.
    expect(journalReadState.maxActive).toBeLessThanOrEqual(EXPECTED_MAX_CONCURRENT_JOURNAL_READS);
  });
});
