import "../test-utils/prepare-compiled-subprocesses.js";
import "../infra/database-engine/backup-worker.test-support.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { agentPortProvider } from "../infra/database-engine/agent-port.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { materializeDatabasePort } from "../infra/database-engine/port.worker.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { PostgresSyncConnection } from "../infra/postgres-sync/connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { upgradeStateDirectory, type StateUpgradeResult } from "./state-upgrade.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("PostgreSQL canonical startup migration", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(async () => {
    await client.connect();
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
    );
  });
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("migrates an additive SQLite agent beside canonical PostgreSQL state without copying either", async () => {
    const root = directories.make("postgres-state-upgrade-");
    const statePath = path.join(root, "state", "openclaw.sqlite");
    const agentPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const storeId = randomUUID();
    const namespace = `upgrade_mixed_${storeId.replaceAll("-", "")}`;
    namespaces.add(namespace);
    const descriptor = await statePortProvider.loadDescriptor();
    {
      using source = openNodeSqliteDatabase(path.join(root, "seed.sqlite"));
      source.exec(descriptor.sqlite);
      for (const fragment of descriptor.fragments ?? []) {
        source.exec(fragment.sqlite);
      }
      source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
        INSERT INTO config_machine_state VALUES ('upgrade-witness', '"original"', 1);`);
      await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent() {},
      });
    }
    fs.rmSync(path.join(root, "seed.sqlite"));
    {
      using anchor = openNodeSqliteDatabase(statePath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
      using agent = openNodeSqliteDatabase(agentPath);
      agent.exec(getOpenClawAgentMigrationSchema(43));
      agent.exec(`PRAGMA user_version = 43;
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', 43, 'main', 1, 1);`);
    }
    const configPath = path.join(root, "openclaw.json");
    const config: OpenClawConfig = {
      database: {
        families: { state: { engine: "postgres" } },
        postgres: { connection },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const originalAnchor = fs.readFileSync(statePath);
    const originalInode = fs.statSync(statePath).ino;
    const originalAgentInode = fs.statSync(agentPath).ino;
    const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
    const prefix = resolvePrefix(env);
    const target = path.join(prefix, "releases", "candidate", "openclaw");
    fs.mkdirSync(target, { recursive: true });
    const pending = await createTrialPending(
      { runId: randomUUID(), target, previous: root, version: "synthetic" },
      prefix,
    );
    await writeTrial({ ...pending, phase: "trial" }, prefix);
    const result = await withDatabaseEngineSelection(
      await resolveDatabaseEngineSelection(config, env),
      async () => {
        const lock = await acquireGatewayLock({
          env,
          role: "sqlite-maintenance",
          allowInTests: true,
        });
        assert(lock);
        try {
          return await lock.run(async () => {
            withEngineStoreAdmission(() => {
              using anchor = openNodeSqliteDatabase(statePath);
              const database = new PostgresSyncConnection(connection!, namespace, anchor, storeId);
              try {
                database.runTransaction(
                  () => bindFreshClientCredentialStore(database, { path: statePath, env }),
                  { maintenance: true },
                );
              } finally {
                database.close();
              }
            });
            return upgradeStateDirectory({ env, log: { info() {}, warn() {} } });
          });
        } finally {
          await lock.release();
        }
      },
    );
    expect(
      (
        await client.query(
          `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'upgrade-witness'`,
        )
      ).rows,
    ).toEqual([{ value_json: '"original"' }]);
    expect(result).toEqual({ status: "upgraded" });
    expect(readBackupEngine(statePath)).toMatchObject({ namespace });
    expect(fs.readFileSync(statePath)).toEqual(originalAnchor);
    expect(fs.statSync(statePath).ino).toBe(originalInode);
    expect(fs.statSync(agentPath).ino).toBe(originalAgentInode);
    using upgradedAgent = openNodeSqliteDatabase(agentPath, { readOnly: true });
    expect(upgradedAgent.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(
      upgradedAgent.prepare("SELECT min_reader FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ min_reader: 43 });
    for (const file of [statePath, agentPath]) {
      expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".pre-"))).toEqual(
        [],
      );
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(path.dirname(target), ".restore"), "utf8")),
    ).toEqual({ v: 1, runId: pending.runId, files: [] });
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
  }, 60_000);

  it("leaves a configured in-tree PostgreSQL agent in place while upgrading SQLite state", async () => {
    const root = directories.make("postgres-configured-agent-upgrade-");
    const statePath = path.join(root, "state", "openclaw.sqlite");
    const agentPath = path.join(root, "custom", "main", "openclaw-agent.sqlite");
    const configPath = path.join(root, "openclaw.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
    openClientCredentialCustody(env, { createIfMissing: true })?.close();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    {
      using state = openNodeSqliteDatabase(statePath);
      state.exec(getOpenClawStatePredecessorSchema(41));
      state.exec(`PRAGMA user_version = 41;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 41, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);`);
      runSqliteImmediateTransactionSync(state, () =>
        bindFreshClientCredentialStore(state, { path: statePath, env }),
      );
    }
    const namespace = `upgrade_configured_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    namespaces.add(namespace);
    const descriptor = await agentPortProvider.loadDescriptor();
    const seedPath = path.join(root, "seed.sqlite");
    {
      using source = openNodeSqliteDatabase(seedPath);
      source.exec(descriptor.sqlite);
      for (const fragment of descriptor.fragments ?? []) {
        source.exec(fragment.sqlite);
      }
      source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
        INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);`);
      await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent() {},
      });
    }
    fs.rmSync(seedPath);
    {
      using anchor = openNodeSqliteDatabase(agentPath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { entries: { main: { agentDir: path.dirname(agentPath) } } },
        database: { families: { agent: { engine: "postgres" } }, postgres: { connection } },
      }),
    );
    const originalAnchor = fs.readFileSync(agentPath);
    const originalAgentInode = fs.statSync(agentPath).ino;
    const originalStateInode = fs.statSync(statePath).ino;
    const lock = await acquireGatewayLock({
      env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    assert(lock);
    let result: StateUpgradeResult;
    try {
      result = await lock.run(() => upgradeStateDirectory({ env, log: { info() {}, warn() {} } }));
    } finally {
      await lock.release();
    }
    expect(result).toEqual({ status: "upgraded" });
    expect(readBackupEngine(agentPath)).toMatchObject({ namespace });
    expect(fs.readFileSync(agentPath)).toEqual(originalAnchor);
    expect(fs.statSync(agentPath).ino).toBe(originalAgentInode);
    expect(fs.statSync(statePath).ino).toBe(originalStateInode);
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    for (const file of [statePath, agentPath]) {
      expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".pre-"))).toEqual(
        [],
      );
    }
    using state = openNodeSqliteDatabase(statePath, { readOnly: true });
    expect(state.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [namespace])).rows,
    ).toEqual([{ present: true }]);
  }, 60_000);
});
