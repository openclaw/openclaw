import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readUpdatePhysicalDatabaseGenerations } from "../infra/update-database-generations.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";

it.each([false, true])(
  "keeps an idle WAL agent store's update generation when preserving sources: %s",
  async (preserveSourceArtifacts) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({ agents: { entries: { main: {} } }, plugins: { enabled: false } });
      const agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();
      // A stopped Gateway leaves its WAL family behind; the next native open with
      // no holder rebuilds -shm and changes the generation recorded at capture.
      const family = state.path("exited-writer");
      fs.mkdirSync(family);
      {
        using writer = new DatabaseSync(agentPath);
        writer.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE fixture_tick(x); DROP TABLE fixture_tick;",
        );
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.copyFileSync(`${agentPath}${suffix}`, path.join(family, suffix || "db"));
        }
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.copyFileSync(path.join(family, suffix || "db"), `${agentPath}${suffix}`);
      }
      const captured = await readUpdatePhysicalDatabaseGenerations([agentPath]);

      const result = await prepareDoctorDatabasePreflight(
        preserveSourceArtifacts ? { preserveSourceArtifacts } : {},
      );

      expect(result).toMatchObject({ incompatible: [], indeterminate: [] });
      expect(
        (await readUpdatePhysicalDatabaseGenerations([agentPath]))[agentPath] ===
          captured[agentPath],
      ).toBe(preserveSourceArtifacts);
    });
  },
);

it.each([true, false])(
  "preserves an unregistered custom WAL store before repair (known history: %s)",
  async (knownHistory) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sharedStatePath = knownHistory
        ? openOpenClawStateDatabase({ env: state.env }).path
        : undefined;
      closeOpenClawStateDatabaseForTest();
      const storeDir = state.path("custom-store");
      fs.mkdirSync(storeDir);
      const pathname = path.join(storeDir, "sessions.sqlite");
      const writer = new DatabaseSync(state.path("fixture-writer.sqlite"));
      try {
        writer.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE schema_meta (
          meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT,
          app_version TEXT, created_at INTEGER, updated_at INTEGER
        );
        INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}, 'retired-owner', 'fixture', 1, 1);
        PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION - 1};
      `);
        fs.copyFileSync(state.path("fixture-writer.sqlite"), pathname);
        fs.copyFileSync(state.path("fixture-writer.sqlite-wal"), `${pathname}-wal`);
      } finally {
        writer.close();
      }
      await state.writeConfig({
        agents: { entries: { main: {} } },
        session: { store: pathname },
      });
      const sourceFiles = [
        pathname,
        `${pathname}-wal`,
        state.configPath,
        ...(sharedStatePath ? [sharedStatePath] : []),
      ];
      const before = sourceFiles.map((file) => fs.readFileSync(file));
      const sharedStateDir = state.statePath("state");
      expect(fs.existsSync(sharedStateDir)).toBe(knownHistory);

      const result = await prepareDoctorDatabasePreflight();

      expect(result).toMatchObject({
        incompatible: [],
        indeterminate: [],
      });
      expect(result.pendingMigrations ?? []).toEqual(
        knownHistory
          ? [
              expect.objectContaining({
                kind: "agent",
                path: pathname,
                foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
              }),
            ]
          : [],
      );
      if (!knownHistory) {
        expect(result.agentDatabaseMigrationDiscovery?.discovery).toMatchObject({
          deletionJournal: {
            status: "unavailable",
            reason: "shared state database missing",
          },
          targets: [],
          retainedTargets: [],
          unverifiedTargets: [
            {
              agentId: "retired-owner",
              path: pathname,
              realPath: fs.realpathSync.native(pathname),
              source: "configured",
            },
          ],
          registryRemovals: [],
          failures: [],
        });
      }
      expect(result.agentRefusals ?? []).toEqual([]);
      expect(fs.readdirSync(storeDir).toSorted()).toEqual([
        "sessions.sqlite",
        "sessions.sqlite-wal",
      ]);
      expect(sourceFiles.map((file) => fs.readFileSync(file))).toEqual(before);
      expect(fs.existsSync(sharedStateDir)).toBe(knownHistory);
    });
  },
);
