import "./test-helpers.mocks.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import {
  noteStateIntegrity,
  stateIntegrityText,
} from "../commands/doctor-state-integrity.test-support.js";
import { flushAgentToolUsage, readAgentToolUsageStatus } from "../config/sessions/tool-usage.js";
import { seedAgentToolUsageRunForTest } from "../config/sessions/tool-usage.test-support.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { waitForMediaCleanupDrainsToSettle } from "./server-media-cleanup-lifecycle.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const LIVE_AGENT_ID = "main";
const MISSING_AGENT_ID = "stale";
const TOOL_ID = "openclaw:synthetic:lookup";
const DAY_MS = 24 * 60 * 60 * 1000;
// tool-usage.kernel.ts retains rows younger than TOOL_USAGE_RETENTION_MS (90d).
const RETENTION_MS = 90 * DAY_MS;

// Raw row read that bypasses the retention filter in the read path, so an expired
// row remains visible to the proof even though readAgentToolUsageStatus hides it.
function readRawToolUsageUpdatedAt(dbPath: string, toolId: string): number | null {
  using db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare("SELECT updated_at AS updatedAt FROM agent_tool_usage WHERE tool_id = ?")
    .get(toolId) as { updatedAt: number } | undefined;
  return row?.updatedAt ?? null;
}

function startMaintenanceWithClock(clock: ReturnType<typeof createGatewaySchedulerClock>) {
  const state = createGatewayMaintenanceStateForTest();
  const scheduler: GatewayScheduler = createTestGatewayScheduler(clock.clock);
  const timers = startGatewayMaintenanceTimers({
    ...state,
    scheduler,
    isNixMode: true,
    runDeliveryQueueMediaGc: undefined,
  });
  return { timers, scheduler };
}

describe("tool-usage retention existing-only product proof", () => {
  it("a Gateway maintenance cycle prunes expired usage without recreating a removed store", async () => {
    const env = process.env;
    const now = Date.now();
    const missingPath = resolveOpenClawAgentSqlitePath({ agentId: MISSING_AGENT_ID, env });
    // A retired agent removed by hand leaves a registry row whose store is gone.
    registerOpenClawAgentDatabase({ agentId: MISSING_AGENT_ID, path: missingPath, env });
    expect(fs.existsSync(missingPath)).toBe(false);

    // A live store holds a fresh row (retention must keep it) and a directly-seeded
    // expired row (retention must delete it). The expired row is written with raw SQL
    // because the production flush path drops rows older than the retention window.
    const live = { agentId: LIVE_AGENT_ID, env };
    const livePath = resolveOpenClawAgentSqlitePath(live);
    const seeded = await seedAgentToolUsageRunForTest({ ...live, now });
    await flushAgentToolUsage({
      ...live,
      generation: seeded.generation,
      startedAt: now,
      now,
      rows: [{ toolId: TOOL_ID, score: 1, updatedAt: now }],
    });
    expect(
      (await readAgentToolUsageStatus({ ...live, now })).rows.some((row) => row.toolId === TOOL_ID),
    ).toBe(true);
    const expiredToolId = "openclaw:synthetic:stale-lookup";
    const expiredUpdatedAt = now - RETENTION_MS - DAY_MS;
    {
      using db = new DatabaseSync(livePath);
      db.prepare("INSERT INTO agent_tool_usage (tool_id, score, updated_at) VALUES (?, ?, ?)").run(
        expiredToolId,
        1,
        expiredUpdatedAt,
      );
    }
    expect(readRawToolUsageUpdatedAt(livePath, expiredToolId)).toBe(expiredUpdatedAt);

    // Run the Gateway maintenance timers on a controlled clock so the proof observes
    // the shipped scheduler firing the startup+130s tool-usage retention task.
    const clock = createGatewaySchedulerClock(now);
    const { timers, scheduler } = startMaintenanceWithClock(clock);
    try {
      await waitForMediaCleanupDrainsToSettle();
      // Before the retention tick the expired row is still present.
      await clock.advanceBy(120_000);
      expect(readRawToolUsageUpdatedAt(livePath, expiredToolId)).toBe(expiredUpdatedAt);
      // The startup+130s retention tick prunes the expired row.
      await clock.advanceBy(10_000);

      // The expired row was deleted by the Gateway maintenance cycle.
      expect(
        readRawToolUsageUpdatedAt(livePath, expiredToolId),
        "expired usage row deleted by the Gateway retention timer",
      ).toBeNull();
      // The fresh row survives the same sweep.
      expect(
        (await readAgentToolUsageStatus({ ...live, now: Date.now() })).rows.some(
          (row) => row.toolId === TOOL_ID,
        ),
        "fresh usage row preserved by the Gateway retention timer",
      ).toBe(true);

      // The removed store stays missing; the running Gateway must not materialize it.
      expect(
        fs.existsSync(missingPath),
        "removed store still absent after the Gateway retention cycle",
      ).toBe(false);
      // Its registry row is preserved for the owner to retire.
      expect(
        listOpenClawRegisteredAgentDatabases({
          env,
          includeIncompatibleSchemaVersions: true,
        }).some((entry) => entry.path === missingPath),
        "removed store's registry row survives the Gateway retention cycle",
      ).toBe(true);
    } finally {
      await timers.stopPeriodicTasks();
      await timers.skillUsageCleanup();
      await timers.stopMediaCleanup();
      await scheduler.stop();
    }

    // Doctor state-integrity on the same state dir must not recreate the removed store either.
    const noteSpy = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    try {
      await noteStateIntegrity(
        { agents: { entries: { [LIVE_AGENT_ID]: {} } } },
        { confirmRuntimeRepair: vi.fn(async () => false) },
      );
    } finally {
      noteSpy.mockRestore();
    }
    expect(stateIntegrityText().length).toBeGreaterThanOrEqual(0);
    expect(
      fs.existsSync(missingPath),
      "removed store still absent after doctor state-integrity",
    ).toBe(false);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }).some((entry) => entry.path === missingPath),
      "removed store's registry row survives doctor",
    ).toBe(true);
    expect(path.basename(missingPath)).toBe("openclaw-agent.sqlite");
  });
});
