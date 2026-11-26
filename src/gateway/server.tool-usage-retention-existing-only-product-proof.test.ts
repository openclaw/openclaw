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
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

const LIVE_AGENT_ID = "main";
const MISSING_AGENT_ID = "stale";
const TOOL_ID = "openclaw:synthetic:lookup";
const DAY_MS = 24 * 60 * 60 * 1000;
// tool-usage.kernel.ts retains rows younger than TOOL_USAGE_RETENTION_MS (90d).
const RETENTION_MS = 90 * DAY_MS;
// The Gateway schedules tool-usage retention MEDIA_CLEANUP_STARTUP_DELAY_MS (130s) after startup.
// Wait past that so the proof observes the shipped scheduler firing, not a manual invocation.
const RETENTION_TIMER_WAIT_MS = 145_000;

installGatewayTestHooks();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Raw row read that bypasses the retention filter in the read path, so an expired
// row remains visible to the proof even though readAgentToolUsageStatus hides it.
function readRawToolUsageUpdatedAt(dbPath: string, toolId: string): number | null {
  using db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare("SELECT updated_at AS updatedAt FROM agent_tool_usage WHERE tool_id = ?")
    .get(toolId) as { updatedAt: number } | undefined;
  return row?.updatedAt ?? null;
}

describe("tool-usage retention existing-only product proof", () => {
  it(
    "a real Gateway maintenance cycle prunes expired usage without recreating a removed store",
    { timeout: 300_000 },
    async () => {
      const env = process.env;
      const now = Date.now();
      const missingPath = resolveOpenClawAgentSqlitePath({ agentId: MISSING_AGENT_ID, env });
      // A retired agent removed by hand leaves a registry row whose store is gone.
      registerOpenClawAgentDatabase({ agentId: MISSING_AGENT_ID, path: missingPath, env });
      expect(fs.existsSync(missingPath)).toBe(false);
      console.log(
        `[proof] removed store absent before Gateway start: ${!fs.existsSync(missingPath)}`,
      );

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
        (await readAgentToolUsageStatus({ ...live, now })).rows.some(
          (row) => row.toolId === TOOL_ID,
        ),
      ).toBe(true);
      const expiredToolId = "openclaw:synthetic:stale-lookup";
      const expiredUpdatedAt = now - RETENTION_MS - DAY_MS;
      {
        using db = new DatabaseSync(livePath);
        db.prepare(
          "INSERT INTO agent_tool_usage (tool_id, score, updated_at) VALUES (?, ?, ?)",
        ).run(expiredToolId, 1, expiredUpdatedAt);
      }
      expect(readRawToolUsageUpdatedAt(livePath, expiredToolId)).toBe(expiredUpdatedAt);
      console.log("[proof] live store holds a fresh row and a directly-seeded expired (91d) row");

      // Bring up a real Gateway: its maintenance timers schedule tool-usage retention.
      // The shared test harness pins OPENCLAW_TEST_MINIMAL_GATEWAY=1, which suppresses the
      // side runtimes that own those timers; lift it just for this startup so the shipped
      // maintenance scheduler runs, then restore the harness default.
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const priorMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
      let server;
      try {
        server = await startTestGatewayServer(portClaim, {
          bind: "loopback",
          auth: { mode: "token", token: "tool-usage-retention-proof-token" },
          controlUiEnabled: false,
        });
      } finally {
        if (priorMinimalGateway === undefined) {
          delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
        } else {
          process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = priorMinimalGateway;
        }
      }
      try {
        // Let the Gateway's own scheduled retention fire (startup + 130s) and run.
        await sleep(RETENTION_TIMER_WAIT_MS);

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
        console.log(
          "[proof] Gateway retention timer pruned the expired row and kept the fresh row",
        );

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
        console.log("[proof] removed store still absent after the Gateway retention cycle");
        console.log("[proof] removed store registry row preserved");

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
        console.log(`[proof] doctor state-integrity ran (${stateIntegrityText().length} chars)`);
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
        console.log("[proof] removed store still absent after doctor state-integrity");
      } finally {
        await server.close();
      }
      expect(path.basename(missingPath)).toBe("openclaw-agent.sqlite");
    },
  );
});
