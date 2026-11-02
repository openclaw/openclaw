import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runDoctorSessionSqlite } from "../../commands/doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import * as sourceSnapshots from "../../infra/sqlite-snapshot-source.js";
import { prepareAgentDatabaseMigrationDiscovery } from "../../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../../infra/state-migrations.media-persistence.js";
import { completeAgentDeletionJournalInDatabase } from "../../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { prepareOpenClawQuarantineRead } from "../../state/openclaw-quarantine-store.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { readClaim as captureClaim } from "./legacy-main-session-migration-claims.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  readClaim,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { copySessionClaimForRepair } from "./session-claim-repair-copy.js";
import { resolveConfiguredAgentDatabaseTargets } from "./targets.js";

const { createFixture } = setupLegacyMainSessionMigrationTests();

it("prepares a cold copy source and refuses its unmatched original physical claim", async () => {
  const { env, stateDir } = createFixture();
  const source = {
    databaseAgentId: "legacy",
    path: databasePath(stateDir, "legacy"),
    ownerStorePath: path.join(stateDir, "agents", "legacy", "sessions", "sessions.json"),
  };
  const destination = {
    databaseAgentId: "owner",
    path: databasePath(stateDir, "owner"),
    ownerStorePath: path.join(stateDir, "agents", "owner", "sessions", "sessions.json"),
  };
  const key = "agent:main:chat";
  const canonicalKey = "agent:owner:chat";
  seedClaim({ databaseAgentId: source.databaseAgentId, databasePath: source.path, key });
  const expected = readClaim({
    databaseAgentId: source.databaseAgentId,
    databasePath: source.path,
    key,
  });
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "cold source copy fixture",
    run: async (authority) => {
      const captured = withOpenClawAgentDatabaseReadOnly(
        (database) => captureClaim(database, source, key, canonicalKey),
        { agentId: source.databaseAgentId, path: source.path, env },
      );
      expect(captured.found).toBe(true);
      if (!captured.found || !captured.value) {
        throw new Error("Expected a real source claim");
      }
      const sourceClaim = captured.value;
      await closeOpenClawAgentDatabaseByPathAsync(source.path);
      openOpenClawAgentDatabase({
        agentId: destination.databaseAgentId,
        path: destination.path,
        env,
      });
      const before = fs.readFileSync(source.path);
      const images: Awaited<ReturnType<typeof sourceSnapshots.prepareSqliteReadOnlyLocation>>[] =
        [];
      const prepare = sourceSnapshots.prepareSqliteReadOnlyLocation;
      using _ = vi
        .spyOn(sourceSnapshots, "prepareSqliteReadOnlyLocation")
        .mockImplementation(async (...args) => {
          const image = await prepare(...args);
          if (args[0] === source.path) {
            expect(fs.existsSync(image.location)).toBe(true);
            images.push(image);
          }
          return image;
        });
      await withSqliteReadOnlyWorkerScope(
        () =>
          withArtifactPreservingStateReads(
            async () => {
              await prepareOpenClawQuarantineRead(env);
              const copied = await copySessionClaimForRepair({
                source: sourceClaim,
                destination,
                canonicalKey,
                env,
                mode: "legacy-main",
                beforePersistentApply: authority.assertCurrent,
              });
              expect(copied).toBeUndefined();
            },
            { agentDatabases: true },
          ),
        { asyncOnly: true },
      );
      expect(images).toHaveLength(1);
      for (const image of images) {
        expect(fs.existsSync(image.location)).toBe(false);
        expect(fs.existsSync(image.cleanupRoot ?? path.dirname(image.location))).toBe(false);
      }
      expect(
        readClaim({
          databaseAgentId: destination.databaseAgentId,
          databasePath: destination.path,
          key: canonicalKey,
        }),
      ).toBeUndefined();
      expect(
        readClaim({
          databaseAgentId: source.databaseAgentId,
          databasePath: source.path,
          key,
        }),
      ).toEqual(expected);
      expect(fs.readFileSync(source.path)).toEqual(before);
    },
  });
});

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
    using db = new DatabaseSync(pathname);
    db.exec("ALTER TABLE session_windows DROP COLUMN row_transcript_json");
    db.exec("ALTER TABLE session_windows DROP COLUMN row_transcript_updated_at");
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
      const targets = {
        env,
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(cfg, { env }),
      };
      const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery(targets);
      expect(
        preparedDiscovery.discovery.retainedTargets.map((target) => target.path).toSorted(),
      ).toEqual(retiredPaths.toSorted());
      await migrateLegacyMediaPersistence({ ...targets, preparedDiscovery });
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
      for (const key of ["agent:owner:chat", "agent:owner:other"]) {
        expect(
          readClaim({ databaseAgentId: "owner", databasePath: activePath, key }),
        ).toBeDefined();
      }
      for (const [index, pathname] of retiredPaths.entries()) {
        expect(fs.readFileSync(pathname)).toEqual(retainedBytes[index]);
        expect(result.warnings).toContain(
          `session: skipped legacy-main scan of held session store ${pathname}; preserved any legacy rows for explicit agent restoration`,
        );
      }
    },
  });
});
