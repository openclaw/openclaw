import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { expectFamilyEqual } from "../../test/helpers/file-snapshots.js";
import { formatCliFailureLines } from "../cli/failure-output.js";
import { readUpdatePhysicalDatabaseGenerations } from "../infra/update-physical-database-generations.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { preflightOpenClawStateDatabasePath } from "../state/openclaw-database-preflight-state-path.js";
import { snapshotSourceFamily } from "../state/openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";

const oldVersion = OPENCLAW_AGENT_SCHEMA_VERSION - 1;

it.each(["state", "agent"] as const)(
  "reports schema-based recovery for a lower-label %s writer without changing the database",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const pathname =
        kind === "state"
          ? openOpenClawStateDatabase({ env: state.env }).path
          : openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();
      const supported =
        kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
      // A different physical file models data written by another build, without cached admission.
      const replacement = state.path("newer.sqlite");
      fs.copyFileSync(pathname, replacement);
      {
        using writer = new DatabaseSync(replacement);
        writer.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${supported + 1}`);
        writer
          .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
          .run("2026.11.4");
      }
      fs.renameSync(replacement, pathname);
      // The replaced file has no clean-close receipt from its writer.
      fs.rmSync(`${pathname}.seal`, { force: true });
      const before = snapshotSourceFamily(pathname);
      const mode = fs.statSync(pathname).mode;
      const open = () =>
        kind === "state"
          ? openOpenClawStateDatabase({ env: state.env })
          : openOpenClawAgentDatabaseReadOnly({ agentId: "main", env: state.env });
      let runtimeFailure: unknown;
      try {
        open();
      } catch (error) {
        runtimeFailure = error;
      }
      expect(runtimeFailure).toMatchObject({ name: "SqliteSchemaVersionError" });
      const runtimeOutput = formatCliFailureLines({
        title: "The CLI command failed.",
        error: runtimeFailure,
        argv: ["node", "openclaw", "status"],
        env: {},
      }).join("\n");
      const doctorFailure = await prepareDoctorDatabasePreflight({
        cfg,
        preserveSourceArtifacts: true,
      }).catch((error: unknown) => error);
      expect(doctorFailure).toMatchObject({ name: "OpenClawDatabaseSchemaPreflightError" });
      const messages = [runtimeOutput, String(doctorFailure)];
      if (kind === "state") {
        const preflight = await preflightOpenClawStateDatabasePath(pathname);
        expect(preflight).toMatchObject({
          status: "incompatible",
          foundVersion: supported + 1,
          targetVersion: supported,
          requiresWrite: false,
        });
        messages.push(preflight.reason ?? "");
      }
      expectFamilyEqual(snapshotSourceFamily(pathname), before);
      expect(fs.statSync(pathname).mode).toBe(mode);
      for (const message of messages) {
        expect(message).toContain(pathname);
        expect(message).toContain(`this build supports ${supported}`);
        expect(message).toContain("2026.11.4");
        expect(message).toContain("Refused by OpenClaw");
        expect(message).toContain("Use a build that supports");
        expect(message).toMatch(/restore a verified pre-(?:update|upgrade) backup/);
        expect(message).toContain("use its matching build");
        expect(message).not.toMatch(/doctor --fix|at least as new as the writer|openclaw update/);
      }
    });
  },
);

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
      {
        using writer = new DatabaseSync(state.path("fixture-writer.sqlite"));
        writer.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE schema_meta (
          meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT,
          app_version TEXT, created_at INTEGER, updated_at INTEGER
        );
        INSERT INTO schema_meta VALUES ('primary', 'agent', ${oldVersion}, 'retired-owner', 'fixture', 1, 1);
        PRAGMA user_version=${oldVersion};
      `);
        fs.copyFileSync(state.path("fixture-writer.sqlite"), pathname);
        fs.copyFileSync(state.path("fixture-writer.sqlite-wal"), `${pathname}-wal`);
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

      expect(result).toMatchObject({ incompatible: [], indeterminate: [] });
      expect(result.pendingMigrations ?? []).toMatchObject(
        knownHistory ? [{ kind: "agent", path: pathname, foundVersion: oldVersion }] : [],
      );
      if (!knownHistory) {
        expect(result.agentDatabaseMigrationDiscovery?.discovery).toMatchObject({
          deletionJournal: {
            status: "unavailable",
            reason: "shared state database missing",
          },
          targets: [],
          unverifiedTargets: [
            expect.objectContaining({
              agentId: "retired-owner",
              path: pathname,
              source: "configured",
            }),
          ],
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
