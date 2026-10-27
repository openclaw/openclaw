import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createCallerModeExecutionFixture,
  createCallerModeSnapshot,
  expectBlockedTailInPlanOrder,
  writeLegacyDoctorSources,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("repairs readable entries before independently preparing mixed agent databases", async () => {
  const root = await tempDirs.make("openclaw-doctor-caller-mixed-databases-");
  const fixture = createCallerModeExecutionFixture(root);
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: {
        heartbeat: { agentId: "healthy" },
        systemAgent: { agentId: "healthy" },
      },
      entries: { current: {}, healthy: {}, broken: {} },
    },
    talk: { agentId: "healthy" },
  };
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
  const currentDatabasePath = createLegacyDatabaseFixture({
    agentId: "current",
    env: fixture.env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    eventsBySession: { repair: [] },
  });
  {
    using database = new DatabaseSync(currentDatabasePath);
    database
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?")
      .run(
        JSON.stringify({
          sessionId: "repair",
          updatedAt: 1,
          delivery: { kind: "none" },
          memoryFlushCompactionCount: 3,
        }),
        "agent:current:repair",
      );
  }
  createLegacyDatabaseFixture({
    agentId: "healthy",
    env: fixture.env,
    eventsBySession: {},
  });
  const brokenDatabasePath = path.join(
    fixture.stateDir,
    "agents/broken/agent/openclaw-agent.sqlite",
  );
  fs.mkdirSync(path.dirname(brokenDatabasePath), { recursive: true });
  fs.writeFileSync(brokenDatabasePath, "not sqlite");
  const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
  const plan = await planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: createCallerModeSnapshot(fixture),
    env: fixture.env,
  });

  const result = await autoMigrateLegacyState({
    cfg,
    doctorOnlyStateMigrations: true,
    env: fixture.env,
    homedir: () => fixture.homeDir,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });

  const receipt = (id: string) => result.stepReceipts.find((step) => step.id === id);
  expect(receipt("session-entry-state-preparation")?.outcome).toBe("completed");
  expect(receipt("media-persistence")).toMatchObject({
    requiredness: "conditional",
    outcome: "refused",
    changes: [expect.stringContaining("Upgraded agent database schema")],
    warnings: [expect.stringContaining(brokenDatabasePath)],
    refusal: { code: "step-refused" },
  });
  {
    using database = new DatabaseSync(currentDatabasePath, { readOnly: true });
    const row = database
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get("agent:current:repair") as { entry_json: string };
    const entry = JSON.parse(row.entry_json) as Record<string, unknown>;
    expect(entry).toMatchObject({
      memoryFlush: { kind: "succeeded", compactionCount: 3 },
    });
    expect(entry).not.toHaveProperty("memoryFlushCompactionCount");
  }
  expectBlockedTailInPlanOrder({
    plan,
    receipts: result.stepReceipts,
    blockerId: "media-persistence",
  });
  expect(fs.existsSync(execPath)).toBe(true);
});
