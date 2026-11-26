import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
import { LEGACY_ROLLBACK_SOURCE } from "../update/legacy-rollback-source.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup retained deletion", () => {
  it.each([
    { cleanupCompleted: true, upgradeShared: false },
    { cleanupCompleted: true, upgradeShared: true },
    { cleanupCompleted: false, upgradeShared: false },
  ])(
    "preserves deletion ownership ($cleanupCompleted, shared upgrade=$upgradeShared)",
    async ({ cleanupCompleted, upgradeShared }) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-retained-"));
      dirs.push(stateDir);
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      };
      openClientCredentialCustody(env, { createIfMissing: true })?.close();
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const retainedDir = path.join(stateDir, "agents", "retired", "agent");
      const retainedPath = path.join(retainedDir, "openclaw-agent.sqlite");
      const activePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      for (const file of [statePath, retainedPath, activePath]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
      {
        using state = new DatabaseSync(statePath);
        const version = OPENCLAW_STATE_SCHEMA_VERSION - Number(upgradeShared);
        state.exec(
          upgradeShared ? getOpenClawStatePredecessorSchema(41) : OPENCLAW_STATE_SCHEMA_SQL,
        );
        state.exec(`PRAGMA user_version = ${version};
          INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
            VALUES ('primary', 'global', ${version}, 1, 1);
          INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${version}', 1);`);
        state
          .prepare(`INSERT INTO agent_deletion_journal
        (agent_id, operation_id, phase, agent_dir, workspace_dir, sessions_dir,
         database_paths_json, created_at, cleanup_completed, delete_files)
        VALUES ('retired', 'delete-retired', 'retiring', ?, ?, ?, ?, 1, ?, 0)`)
          .run(
            retainedDir,
            path.join(stateDir, "workspace-retired"),
            path.join(stateDir, "agents", "retired", "sessions"),
            JSON.stringify([retainedPath]),
            Number(cleanupCompleted),
          );
        runSqliteImmediateTransactionSync(state, () =>
          bindFreshClientCredentialStore(state, { env, path: statePath }),
        );
      }
      {
        const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-current-agent-"));
        dirs.push(seedDir);
        const seedPath = path.join(seedDir, "agents", "main", "agent", "openclaw-agent.sqlite");
        // Publish genuine deletion custody before Doctor discovers the agent.
        openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: seedDir } });
        fs.mkdirSync(path.dirname(seedPath), { recursive: true });
        {
          using active = new DatabaseSync(seedPath);
          active.exec(OPENCLAW_AGENT_SCHEMA_SQL);
          active.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
            INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
              VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);`);
          active.exec(`INSERT INTO session_nodes
            (session_key, current_session_id, entry_json, updated_at)
            VALUES ('agent:main:main', 'active-session', '{"sessionId":"active-session"}', 1)`);
        }
        // Prepare both Doctor content owners before treating the agent as current.
        const prepared = await autoMigrateLegacyState({
          cfg: {},
          env: { OPENCLAW_STATE_DIR: seedDir },
          doctorOnlyStateMigrations: true,
        });
        throwIfDoctorStateMigrationRefused(prepared.stepReceipts);
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
        fs.renameSync(seedPath, activePath);
      }
      {
        using retained = new DatabaseSync(retainedPath, { allowExtension: true });
        retained.exec(
          fs.readFileSync(
            new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
            "utf8",
          ),
        );
        retained.exec(`PRAGMA user_version = 26;
        INSERT INTO schema_meta VALUES ('primary', 'agent', 26, 'retired', '2026.9.9', 1, 1);
        INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:retired:main', 'archived-session', '{"sessionId":"archived-session"}', 1);`);
        loadSqliteVec(retained);
        retained.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(embedding float[3]);
        INSERT INTO memory_index_chunks_vec(rowid, embedding) VALUES (1, '[1, 0, 0]');`);
      }
      const bytes = fs.readFileSync(retainedPath);
      const activeIdentity = fs.statSync(activePath);
      const snapshotActive = () => {
        using database = new DatabaseSync(activePath, { readOnly: true });
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
      const activeSnapshot = snapshotActive();
      const log = { info: vi.fn(), warn: vi.fn() };
      const upgrade = upgradeStateDirectory({
        env,
        log,
      });
      if (cleanupCompleted) {
        await expect(upgrade).resolves.toEqual({
          status: upgradeShared ? "upgraded" : "current",
        });
        if (upgradeShared) {
          using state = new DatabaseSync(statePath, { readOnly: true });
          const ownership = state
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
            )
            .get();
          expect(JSON.parse(String(ownership?.value_json))).toEqual({ location: "state-db" });
        }
      } else {
        await expect(upgrade).resolves.toEqual({
          status: "refused",
          reason: "OpenClaw agent database is unavailable while agent retired is deleted.",
        });
      }
      await closeOpenClawAgentDatabasesAsync();
      expect(fs.readFileSync(retainedPath)).toEqual(bytes);
      expect(fs.readdirSync(retainedDir)).toEqual(["openclaw-agent.sqlite"]);
      expect(fs.statSync(activePath)).toMatchObject({
        dev: activeIdentity.dev,
        ino: activeIdentity.ino,
      });
      // Doctor refreshes optimizer statistics; every user row and schema stays intact.
      expect(snapshotActive()).toEqual(activeSnapshot);
    },
  );
});

describe("canonical in-place migration", () => {
  it.each([false, true])(
    "preserves live inodes and images only a rising reader floor (trial: %s)",
    async (trial) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-in-place-"));
      dirs.push(stateDir);
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      };
      openClientCredentialCustody(env, { createIfMissing: true })?.close();
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      const authoredConfig = trial ? '{"agents":{"list":[{"id":"main"}]}}\n' : "{}";
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, authoredConfig);
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      for (const file of [statePath, agentPath]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
      {
        using state = new DatabaseSync(statePath);
        state.exec(getOpenClawStatePredecessorSchema(41));
        state.exec(`PRAGMA journal_mode = WAL;
          PRAGMA user_version = 41;
          INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
            VALUES ('primary', 'global', 41, 1, 1);
          INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);
          INSERT INTO config_machine_state VALUES ('plugins.bundledDiscovery', '"all"', 1);`);
        runSqliteImmediateTransactionSync(state, () =>
          bindFreshClientCredentialStore(state, { env, path: statePath }),
        );
        using agent = new DatabaseSync(agentPath);
        agent.exec(getOpenClawAgentMigrationSchema(43));
        agent.exec(`PRAGMA user_version = 43;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
            VALUES ('primary', 'agent', 43, 'main', 1, 1);`);
      }
      const stateIdentity = fs.statSync(statePath);
      const agentIdentity = fs.statSync(agentPath);
      const prefix = resolvePrefix(env);
      const target = path.join(prefix, "releases", "candidate", "openclaw");
      const manifestPath = path.join(path.dirname(target), ".restore");
      if (trial) {
        fs.mkdirSync(target, { recursive: true });
        const pending = await createTrialPending(
          { runId: "in-place-floor", target, previous: stateDir, version: "synthetic" },
          prefix,
        );
        await writeTrial({ ...pending, phase: "trial" }, prefix);
      }
      const rename = fs.renameSync;
      const publication = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (String(destination) === manifestPath) {
          // The durable restore intent must precede the first canonical mutation.
          using live = new DatabaseSync(statePath, { readOnly: true });
          expect(live.prepare("PRAGMA user_version").get()).toEqual({ user_version: 41 });
          using agent = new DatabaseSync(agentPath, { readOnly: true });
          expect(agent.prepare("PRAGMA user_version").get()).toEqual({ user_version: 43 });
          expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authoredConfig);
          if (trial) {
            const configOriginal = `${env.OPENCLAW_CONFIG_PATH}.pre-${resolveRuntimeServiceBuildId() ?? VERSION}`;
            expect(fs.existsSync(configOriginal), "config original must precede manifest").toBe(
              true,
            );
            expect(
              fs.readFileSync(configOriginal, "utf8"),
              "config original must precede manifest",
            ).toBe(authoredConfig);
          }
        }
        rename(source, destination);
      });
      const upgrade = async () => {
        const lock = await acquireGatewayLock({
          env,
          role: "sqlite-maintenance",
          allowInTests: true,
        });
        try {
          return await lock?.run(() =>
            upgradeStateDirectory({ env, log: { info() {}, warn() {} } }),
          );
        } finally {
          await lock?.release();
        }
      };
      const result = await upgrade();
      expect(result, JSON.stringify(result)).toEqual({ status: "upgraded" });
      publication.mockRestore();
      if (trial) {
        const repairedConfig = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8"));
        expect(repairedConfig).toHaveProperty("agents.entries.main", {});
        expect(repairedConfig).not.toHaveProperty("agents.list");
      }
      for (const [file, identity] of [
        [statePath, stateIdentity],
        [agentPath, agentIdentity],
      ] as const) {
        expect(fs.statSync(file)).toMatchObject({ dev: identity.dev, ino: identity.ino });
      }
      expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
      expect(
        fs.readdirSync(path.dirname(agentPath)).filter((name) => name.includes(".pre-")),
      ).toEqual([]);
      {
        using state = new DatabaseSync(statePath);
        expect(state.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(state.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_STATE_SCHEMA_VERSION,
        });
        const metadata = state
          .prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'")
          .get();
        expect(metadata?.min_reader ?? metadata?.schema_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        state.exec(
          `UPDATE config_machine_state SET value_json = '"allowlist"' WHERE state_key = 'plugins.bundledDiscovery'`,
        );
        using agent = new DatabaseSync(agentPath);
        expect(agent.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        expect(
          agent.prepare("SELECT min_reader FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ min_reader: 43 });
      }
      await expect(
        executeExistingOpenClawStateRead(
          { env },
          { type: "plugins.metadata.read", input: { stateKeys: ["plugins.bundledDiscovery"] } },
        ),
      ).resolves.toMatchObject({
        type: "plugins.metadata.read",
        rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }],
      });
      const generation = resolveRuntimeServiceBuildId() ?? VERSION;
      const preimage = `${statePath}.pre-${generation}`;
      const configPreimage = `${env.OPENCLAW_CONFIG_PATH}.pre-${generation}`;
      expect(fs.existsSync(manifestPath)).toBe(trial);
      expect(fs.existsSync(preimage)).toBe(trial);
      expect(fs.existsSync(configPreimage)).toBe(trial);
      if (trial) {
        const encoded = fs.readFileSync(manifestPath, "utf8");
        const manifest = JSON.parse(encoded) as {
          v: number;
          runId: string;
          files: Array<{ live: string; preimage: string | null }>;
        };
        expect(manifest).toMatchObject({ v: 1, runId: "in-place-floor" });
        expect(manifest.files.filter((file) => file.preimage !== null)).toEqual([
          { live: statePath, preimage },
          { live: env.OPENCLAW_CONFIG_PATH, preimage: configPreimage },
        ]);
        expect(fs.readFileSync(configPreimage, "utf8")).toBe(authoredConfig);
        expect(manifest.files.some((file) => file.live.startsWith(agentPath))).toBe(false);
        expect(fs.statSync(preimage).ino).not.toBe(stateIdentity.ino);
        {
          using image = new DatabaseSync(preimage, { readOnly: true });
          expect(image.prepare("PRAGMA user_version").get()).toEqual({ user_version: 41 });
          expect(
            image
              .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
              .get("plugins.bundledDiscovery"),
          ).toEqual({ value_json: '"all"' });
        }
        const imageIdentity = fs.statSync(preimage);
        const configImageIdentity = fs.statSync(configPreimage);
        await expect(upgrade()).resolves.toEqual({ status: "current" });
        expect(fs.readFileSync(manifestPath, "utf8")).toBe(encoded);
        expect(fs.statSync(preimage)).toMatchObject({
          dev: imageIdentity.dev,
          ino: imageIdentity.ino,
        });
        expect(fs.statSync(configPreimage)).toMatchObject({
          dev: configImageIdentity.dev,
          ino: configImageIdentity.ino,
        });
        expect(fs.readFileSync(configPreimage, "utf8")).toBe(authoredConfig);
        await closeOpenClawStateDatabaseAsync();
        runInNewContext(
          `${LEGACY_ROLLBACK_SOURCE}\nconst files=collectPreserved(stateDir,suffix,0,4,[]); retirePlans(stateDir,generation); restoreState(files,suffix);`,
          { fs, path, stateDir, generation, suffix: `.pre-${generation}` },
        );
        expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authoredConfig);
        using restored = new DatabaseSync(statePath, { readOnly: true });
        expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 41 });
        expect(
          restored
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("plugins.bundledDiscovery"),
        ).toEqual({ value_json: '"all"' });
      }
    },
  );
});

describe("upgradeStateDirectory version zero", () => {
  it("leaves a fresh empty catalog to the normal bootstrap", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-v0-"));
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, "state"));
    fs.writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "");
    // Fresh agent catalogs also belong to bootstrap.
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"), "");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
    };
    const result = await upgradeStateDirectory({
      env,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result).toEqual({ status: "current" });
  });
});
