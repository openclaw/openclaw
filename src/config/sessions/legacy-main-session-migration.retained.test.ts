import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { runDoctorSessionSqlite } from "../../commands/doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { prepareAgentDatabaseMigrationDiscovery } from "../../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../../infra/state-migrations.media-persistence.js";
import { completeAgentDeletionJournalInDatabase } from "../../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  readClaim,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { resolveConfiguredAgentDatabaseTargets } from "./targets.js";

const { createFixture } = setupLegacyMainSessionMigrationTests();

it("migrates active legacy-main rows without admitting retained retired databases", async () => {
  const { cfg, env, stateDir } = createFixture({ agents: { entries: { owner: {} } } });
  const activePath = databasePath(stateDir, "owner");
  const ordinaryPath = databasePath(stateDir, "ordinary");
  seedClaim({ databaseAgentId: "owner", databasePath: activePath, key: "agent:main:chat" });
  seedClaim({ databaseAgentId: "ordinary", databasePath: ordinaryPath, key: "agent:main:other" });
  const retiredIds = ["retired-a", "retired-b"];
  const retiredPaths = retiredIds.map((agentId) => {
    const pathname = databasePath(stateDir, agentId);
    openOpenClawAgentDatabase({ agentId, path: pathname, env });
    return pathname;
  });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  for (const pathname of [activePath, ordinaryPath, ...retiredPaths]) {
    const db = new DatabaseSync(pathname);
    try {
      db.exec("ALTER TABLE session_windows DROP COLUMN row_transcript_json");
      db.exec("ALTER TABLE session_windows DROP COLUMN row_transcript_updated_at");
    } finally {
      db.close();
    }
  }
  for (const [index, agentId] of retiredIds.entries()) {
    const operationId = `retain-${agentId}`;
    beginAgentDeletionJournal(
      {
        agentId,
        operationId,
        agentDir: path.dirname(retiredPaths[index]!),
        databasePaths: [retiredPaths[index]!],
        workspaceDir: path.join(stateDir, `workspace-${agentId}`),
        sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
        deleteFiles: false,
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, agentId, operationId),
      { env },
    );
  }
  const retainedBytes = retiredPaths.map((pathname) => fs.readFileSync(pathname));
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "retained legacy-main migration fixture",
    run: async (authority) => {
      const configuredAgentDatabaseTargets = resolveConfiguredAgentDatabaseTargets(cfg, { env });
      const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
        env,
        configuredAgentDatabaseTargets,
      });
      expect(
        preparedDiscovery.discovery.retainedTargets.map((target) => target.path).toSorted(),
      ).toEqual(retiredPaths.toSorted());
      await migrateLegacyMediaPersistence({
        env,
        configuredAgentDatabaseTargets,
        preparedDiscovery,
      });
      await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" }, authority);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const result = await migrateLegacyMainSessionKeys({
        cfg,
        env,
        mode: "doctor-fix",
        beforePersistentApply: () => authority.assertCurrent(),
      });
      expect(result.complete).toBe(true);
      expect(
        readClaim({ databaseAgentId: "owner", databasePath: activePath, key: "agent:owner:chat" }),
      ).toBeDefined();
      expect(
        readClaim({ databaseAgentId: "owner", databasePath: activePath, key: "agent:owner:other" }),
      ).toBeDefined();
      for (const [index, pathname] of retiredPaths.entries()) {
        expect(fs.readFileSync(pathname)).toEqual(retainedBytes[index]);
        expect(result.warnings).toContain(
          `session: skipped legacy-main scan of held session store ${pathname}; preserved any legacy rows for explicit agent restoration`,
        );
      }
    },
  });
});
