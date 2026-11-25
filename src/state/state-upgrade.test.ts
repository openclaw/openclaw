import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { isStateUpgradePending } from "./state-upgrade-databases.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
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
        state.exec(OPENCLAW_STATE_SCHEMA_SQL);
        // Exercise both current and outdated shared-state catalogs.
        state.exec(
          `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - Number(upgradeShared)}`,
        );
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
      }
      {
        using active = new DatabaseSync(activePath);
        active.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        active.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
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
      const activeBytes = fs.readFileSync(activePath);
      const log = { info: vi.fn(), warn: vi.fn() };
      const upgrade = upgradeStateDirectory({
        env,
        log,
      });
      if (cleanupCompleted) {
        await expect(upgrade).resolves.toMatchObject(
          upgradeShared ? { status: "upgraded" } : { status: "current" },
        );
        expect(await isStateUpgradePending(env)).toBe(false);
      } else {
        await expect(upgrade).rejects.toThrow("no such module: vec0");
        expect(await isStateUpgradePending(env)).toBe(true);
      }
      expect(fs.readFileSync(retainedPath)).toEqual(bytes);
      expect(fs.readdirSync(retainedDir)).toEqual(["openclaw-agent.sqlite"]);
      expect(fs.readFileSync(activePath)).toEqual(activeBytes);
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
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
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
          INSERT INTO config_machine_state VALUES ('upgrade-witness', '"before"', 1);`);
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
      const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
      try {
        await expect(
          upgradeStateDirectory({ env, log: { info() {}, warn() {} } }),
        ).resolves.toEqual({ status: "upgraded" });
      } finally {
        await lock?.release();
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
          `UPDATE config_machine_state SET value_json = '"after"' WHERE state_key = 'upgrade-witness'`,
        );
        using agent = new DatabaseSync(agentPath);
        expect(agent.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        expect(agent.prepare("SELECT min_reader FROM schema_meta").get()).toEqual({
          min_reader: 43,
        });
      }
      await expect(
        executeExistingOpenClawStateRead(
          { env },
          { type: "plugins.metadata.read", input: { stateKeys: ["upgrade-witness"] } },
        ),
      ).resolves.toMatchObject({
        type: "plugins.metadata.read",
        rows: [{ state_key: "upgrade-witness", value_json: '"after"' }],
      });
      const preimage = `${statePath}.pre-${resolveRuntimeServiceBuildId() ?? VERSION}`;
      expect(fs.existsSync(manifestPath)).toBe(trial);
      expect(fs.existsSync(preimage)).toBe(trial);
      if (trial) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          v: number;
          runId: string;
          files: Array<{ live: string; preimage: string | null }>;
        };
        expect(manifest).toMatchObject({ v: 1, runId: "in-place-floor" });
        expect(manifest.files.filter((file) => file.preimage !== null)).toEqual([
          { live: statePath, preimage },
        ]);
        expect(manifest.files.some((file) => file.live.startsWith(agentPath))).toBe(false);
        expect(fs.statSync(preimage).ino).not.toBe(stateIdentity.ino);
        using image = new DatabaseSync(preimage, { readOnly: true });
        expect(image.prepare("PRAGMA user_version").get()).toEqual({ user_version: 41 });
        expect(
          image
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("upgrade-witness"),
        ).toEqual({ value_json: '"before"' });
      }
    },
  );
});

describe("upgradeStateDirectory version zero", () => {
  it("leaves a fresh empty catalog to the normal bootstrap", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-v0-"));
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, "state"));
    const anchor = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    anchor.exec("CREATE TABLE anchor (v TEXT)");
    anchor.close();
    // Fresh agent catalogs also belong to bootstrap.
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    const agent = new DatabaseSync(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    agent.exec("CREATE TABLE t (v TEXT)");
    agent.close();
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
    };
    expect(await isStateUpgradePending(env)).toBe(false);
    const result = await upgradeStateDirectory({
      env,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result).toEqual({ status: "current" });
  });
});
