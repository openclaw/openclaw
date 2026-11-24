import "../test-utils/prepare-compiled-subprocesses.js";
import "../infra/database-engine/backup-worker.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { agentPortProvider } from "../infra/database-engine/agent-port.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { materializeDatabasePort } from "../infra/database-engine/port.worker.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { ROLLBACK_SOURCE } from "../update/rollback-source.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { pruneGenerations } from "./state-upgrade-tree.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("PostgreSQL startup copy and swap", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it.each([false, true])(
    "protects mixed stores (chain fails: %s)",
    async (fail) => {
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
        agent.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
      }
      const configPath = path.join(root, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          database: {
            families: { state: { engine: "postgres" } },
            postgres: { connection },
          },
        }),
      );
      const originalAnchor = fs.readFileSync(statePath);
      let privateNamespace: string | undefined;
      const result = await upgradeStateDirectory({
        env: { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath },
        log: { info() {}, warn() {} },
        runChain: async ({ stateDir }) => {
          const shadow = readBackupEngine(path.join(stateDir, "state", "openclaw.sqlite"));
          expect(shadow.engine).toBe("postgres");
          if (shadow.engine !== "postgres") {
            throw new Error("Expected private PostgreSQL anchor");
          }
          namespaces.add(shadow.namespace);
          privateNamespace = shadow.namespace;
          expect(shadow.namespace).not.toBe(namespace);
          await client.query(
            `UPDATE "${shadow.namespace}".config_machine_state SET value_json = '"private"' WHERE state_key = 'upgrade-witness'`,
          );
          using agent = openNodeSqliteDatabase(
            path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          );
          agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
          if (fail) {
            throw new Error("candidate stopped after private migration");
          }
          return { warnings: [] };
        },
      });
      expect(
        (
          await client.query(
            `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'upgrade-witness'`,
          )
        ).rows,
      ).toEqual([{ value_json: '"original"' }]);
      if (fail) {
        expect(result).toMatchObject({
          status: "refused",
          reason: expect.stringContaining("candidate stopped after private migration"),
        });
        expect(fs.readFileSync(statePath)).toEqual(originalAnchor);
        using originalAgent = openNodeSqliteDatabase(agentPath, { readOnly: true });
        expect(originalAgent.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
        });
      } else {
        expect(result).toMatchObject({ status: "upgraded", mode: "chain" });
        expect(readBackupEngine(statePath)).not.toMatchObject({ namespace });
        const previous = fs
          .readdirSync(path.dirname(statePath))
          .find((file) => file.startsWith("openclaw.sqlite.pre-") && !file.includes(".pre-trial-"));
        expect(previous).toBeDefined();
        expect(fs.readFileSync(path.join(path.dirname(statePath), previous!))).toEqual(
          originalAnchor,
        );
        using upgradedAgent = openNodeSqliteDatabase(agentPath, { readOnly: true });
        expect(upgradedAgent.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        // Exercise the already-installed launcher's file-only recovery, then the
        // next generation's cleanup of the failed candidate's retained anchor.
        const suffix = previous!.slice("openclaw.sqlite".length);
        runInNewContext(
          `${ROLLBACK_SOURCE}\nrestoreState(collectPreserved(stateDir, suffix, 0, 4, []), suffix); retirePlans(stateDir, generation);`,
          { fs, path, stateDir: root, suffix, generation: suffix.slice(".pre-".length) },
        );
        expect(fs.readFileSync(statePath)).toEqual(originalAnchor);
        const retainedConfigPath = path.join(root, "state", "openclaw.json");
        fs.writeFileSync(`${retainedConfigPath}.pre-next-generation`, "{}");
        await pruneGenerations(
          root,
          "next-generation",
          new Set(),
          new Set([statePath, retainedConfigPath]),
          {
            config: { database: { engine: "postgres", postgres: { connection } } },
            activeAnchors: [statePath],
            warn: (message) => {
              throw new Error(message);
            },
          },
        );
        expect(
          (await client.query("SELECT to_regnamespace($1) IS NULL AS removed", [privateNamespace]))
            .rows,
        ).toEqual([{ removed: true }]);
        expect(
          (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [namespace]))
            .rows,
        ).toEqual([{ present: true }]);
        expect(fs.existsSync(path.join(path.dirname(statePath), previous!))).toBe(false);
      }
    },
    60_000,
  );

  it("protects a configured in-tree PostgreSQL agent while upgrading SQLite state", async () => {
    const root = directories.make("postgres-configured-agent-upgrade-");
    const statePath = path.join(root, "state", "openclaw.sqlite");
    const agentPath = path.join(root, "custom", "main", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    {
      using state = openNodeSqliteDatabase(statePath);
      state.exec(OPENCLAW_STATE_SCHEMA_SQL);
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
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
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { entries: { main: { agentDir: path.dirname(agentPath) } } },
        database: { families: { agent: { engine: "postgres" } }, postgres: { connection } },
      }),
    );
    const originalAnchor = fs.readFileSync(agentPath);
    const result = await upgradeStateDirectory({
      env: { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath },
      log: { info() {}, warn() {} },
      runChain: async ({ stateDir }) => {
        const privatePath = path.join(stateDir, "custom", "main", "openclaw-agent.sqlite");
        const privateAgent = readBackupEngine(privatePath);
        expect(privateAgent.engine).toBe("postgres");
        if (privateAgent.engine !== "postgres") {
          throw new Error("Expected private PostgreSQL agent");
        }
        namespaces.add(privateAgent.namespace);
        expect(privateAgent.namespace).not.toBe(namespace);
        using state = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"));
        state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
        return { warnings: [] };
      },
    });
    expect(result).toMatchObject({ status: "upgraded", mode: "chain" });
    const previous = fs
      .readdirSync(path.dirname(agentPath))
      .find(
        (file) => file.startsWith("openclaw-agent.sqlite.pre-") && !file.includes(".pre-trial-"),
      );
    expect(fs.readFileSync(path.join(path.dirname(agentPath), previous!))).toEqual(originalAnchor);
    expect(
      (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [namespace])).rows,
    ).toEqual([{ present: true }]);
  }, 60_000);
});
