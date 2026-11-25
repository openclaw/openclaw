import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { sha256File } from "../infra/crypto-digest.js";
import { readSqliteCleanCloseSeal } from "../infra/sqlite-clean-close-seal.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
} from "../infra/state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
import { detectSharedAuthStoreMigration } from "../infra/state-migrations.shared-auth-store.js";
import { prepareLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup canonical ownership", () => {
  it("leaves large current registered agent databases in place while migrating shared state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-registry-"));
    dirs.push(stateDir);
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    openClientCredentialCustody(env, { createIfMissing: true })?.close();
    const agentPath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    {
      const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-current-agent-"));
      dirs.push(seedDir);
      const seedPath = path.join(seedDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      // Publish genuine deletion custody before Doctor discovers the agent.
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: seedDir } });
      fs.mkdirSync(path.dirname(seedPath), { recursive: true });
      {
        using agent = new DatabaseSync(seedPath);
        agent.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        agent
          .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)")
          .run(OPENCLAW_AGENT_SCHEMA_VERSION);
        agent.exec(`INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:main:main', 'retained-session', '{"sessionId":"retained-session"}', 1)`);
      }
      const prepared = await autoMigrateLegacyState({
        cfg: {},
        env: { OPENCLAW_STATE_DIR: seedDir },
        doctorOnlyStateMigrations: true,
      });
      throwIfDoctorStateMigrationRefused(prepared.stepReceipts);
      // Session rows and content-completion metadata must also be canonical-current.
      await noteSessionTranscriptHealth({
        cfg: {},
        env: { OPENCLAW_STATE_DIR: seedDir },
        shouldRepair: true,
        ...(prepared.postSessionPluginMigration
          ? { postSessionPluginMigration: prepared.postSessionPluginMigration }
          : {}),
        postSessionPluginMigrationPlanBound: true,
        onStepReceipt: (receipt) => throwIfDoctorStateMigrationRefused([receipt]),
      });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      fs.renameSync(seedPath, agentPath);
    }
    fs.truncateSync(agentPath, 64 * 1024 * 1024 + 4096);
    const statePath = path.join(stateDir, "state/openclaw.sqlite");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    {
      using state = new DatabaseSync(statePath);
      state.exec(getOpenClawStatePredecessorSchema(41));
      // The shared catalog is v41; the registered agent database is already current.
      state.exec(`PRAGMA user_version = 41;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 41, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);`);
      state
        .prepare("INSERT INTO agent_databases VALUES ('main', ?, ?, 1, ?)")
        .run(
          "agents/main/agent/openclaw-agent.sqlite",
          OPENCLAW_AGENT_SCHEMA_VERSION,
          fs.statSync(agentPath).size,
        );
      runSqliteImmediateTransactionSync(state, () =>
        bindFreshClientCredentialStore(state, { env, path: statePath }),
      );
    }
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
    const readRegistry = () => {
      using state = new DatabaseSync(statePath, { readOnly: true });
      return state
        .prepare(
          "SELECT agent_id, path, schema_version, size_bytes FROM agent_databases ORDER BY agent_id, path",
        )
        .all();
    };
    const registrations = readRegistry();
    const agentIdentity = fs.statSync(agentPath);
    const snapshotLogical = (file: string) => {
      using database = new DatabaseSync(file, { readOnly: true });
      const schema = database
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT IN ('sqlite_stat1', 'sqlite_stat2', 'sqlite_stat3', 'sqlite_stat4')
           ORDER BY type, name`,
        )
        .all();
      return {
        userVersion: database.prepare("PRAGMA user_version").get(),
        applicationId: database.prepare("PRAGMA application_id").get(),
        schema,
        tables: schema
          .filter((entry) => entry.type === "table")
          .map((entry) => {
            const name = String(entry.name);
            const withoutRowid =
              database
                .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
                .get(name)?.wr === 1;
            const sql = `SELECT ${withoutRowid ? "" : "rowid, "}* FROM ${quoteSqliteIdentifier(name)}`;
            const order = database
              .prepare(sql)
              .columns()
              .map((_, index) => index + 1)
              .join(", ");
            const rows = database.prepare(`${sql} ORDER BY ${order}`);
            rows.setReadBigInts(true);
            return { name, rows: rows.all() };
          }),
      };
    };
    const originalAgent = snapshotLogical(agentPath);
    const stateIdentity = fs.statSync(statePath);
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await upgradeStateDirectory({
      env,
      log,
    });
    await closeOpenClawAgentDatabasesAsync();
    expect(readRegistry()).toEqual(registrations);
    expect(result, JSON.stringify({ result, warnings: log.warn.mock.calls })).toEqual({
      status: "upgraded",
    });
    expect(fs.statSync(agentPath)).toMatchObject({
      dev: agentIdentity.dev,
      ino: agentIdentity.ino,
    });
    // The first Doctor pass may refresh optimizer pages, not user data.
    expect(snapshotLogical(agentPath)).toEqual(originalAgent);
    expect(fs.statSync(statePath)).toMatchObject({
      dev: stateIdentity.dev,
      ino: stateIdentity.ino,
    });
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    expect(
      fs.readdirSync(path.dirname(agentPath)).filter((name) => name.includes(".pre-")),
    ).toEqual([]);
    // The existing clean-close owner may publish its validated seal, not an upgrade copy.
    expect(
      readSqliteCleanCloseSeal(agentPath, fs.statSync(agentPath, { bigint: true })),
    ).toBeDefined();
    {
      using state = new DatabaseSync(statePath, { readOnly: true });
      expect(state.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      const ownership = state
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'")
        .get();
      expect(JSON.parse(String(ownership?.value_json))).toEqual({ location: "state-db" });
    }
    const migratedState = snapshotLogical(statePath);
    const agentBytes = await sha256File(agentPath);
    const stateBytes = await sha256File(statePath);
    const currentAgentIdentity = fs.statSync(agentPath);
    const legacy = await detectSharedAuthStoreMigration({
      stateDir,
      env,
      config: {},
      doctorOnlyStateMigrations: true,
      artifactPreservingReadOnly: true,
    });
    expect(legacy.hasLegacy).toBe(false);
    const pending = await detectLegacyStateMigrations({
      cfg: {},
      env,
      doctorOnlyStateMigrations: true,
      artifactPreservingReadOnly: true,
      legacySessionSurfaces: await prepareLegacySessionSurfaces({ config: {}, env }),
    });
    expect(pending.preview).toEqual([]);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    await expect(upgradeStateDirectory({ env, log })).resolves.toEqual({ status: "current" });
    await closeOpenClawAgentDatabasesAsync();
    expect(exec).not.toHaveBeenCalledWith(expect.stringMatching(/\bANALYZE\b/i));
    expect(await sha256File(agentPath)).toBe(agentBytes);
    expect(await sha256File(statePath)).toBe(stateBytes);
    expect(fs.statSync(agentPath)).toMatchObject({
      dev: currentAgentIdentity.dev,
      ino: currentAgentIdentity.ino,
      size: currentAgentIdentity.size,
    });
    expect(fs.statSync(statePath)).toMatchObject({
      dev: stateIdentity.dev,
      ino: stateIdentity.ino,
    });
    expect(snapshotLogical(agentPath)).toEqual(originalAgent);
    expect(snapshotLogical(statePath)).toEqual(migratedState);
    expect(readRegistry()).toEqual(registrations);
  });
});
