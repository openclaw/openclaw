import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { planLegacyConfigForUpdateChannel } from "../../commands/doctor/legacy-config-repair.js";
import { createConfigIO } from "../../config/io.js";
import { withTempHome, writeOpenClawConfig } from "../../config/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import {
  captureOwnedManagedUpdatePreflightContext,
  revalidateUpdateDatabaseContext,
} from "./update-command-managed-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("target-release database schema preflight", () => {
  it("admits shared state in one online copy while a writer thread keeps committing", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("update-busy-preflight-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const source = openOpenClawStateDatabase({ env }).path;
    // The updater's ledger retains a live source owner; inspection must pin its own reader.
    const backups = path.join(stateDir, "backups.jsonl");
    const preload = path.join(stateDir, "backup-progress.cjs");
    fs.writeFileSync(
      preload,
      `
      const fs = require("node:fs");
      const sqlite = require("node:sqlite");
      const backup = sqlite.backup;
      sqlite.backup = async function(source, destination, options) {
        const pages = await backup(source, destination, options);
        const snapshot = new sqlite.DatabaseSync(destination, { readOnly: true });
        try {
          const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
          fs.appendFileSync(${JSON.stringify(backups)}, JSON.stringify({ integrity, pages }) + "\\n");
        } finally {
          snapshot.close();
        }
        return pages;
      };
    `,
    );
    const writer = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=64; CREATE TABLE update_witness(generation INTEGER); INSERT INTO update_witness VALUES(0)");
      let generation = 0;
      let stopping = false;
      parentPort.on("message", () => { stopping = true; });
      function write() {
        if (stopping) {
          db.close();
          parentPort.postMessage(generation);
          parentPort.close();
          return;
        }
        db.prepare("UPDATE update_witness SET generation=?").run(++generation);
        if (generation === 1) parentPort.postMessage(generation);
        setImmediate(write);
      }
      write();
    `,
      { eval: true, workerData: source },
    );
    const exited = once(writer, "exit");
    try {
      await once(writer, "message");
      const result = await withEnvAsync(sqliteWorkerPreloadEnv(preload), () =>
        checkTargetDatabaseSchemasForContexts(
          { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
          [{ config: {}, env }],
        ),
      );
      expect(result).toEqual({ incompatible: [], indeterminate: [] });
      const copies = fs.readFileSync(backups, "utf8").trim().split("\n");
      expect(copies).toHaveLength(1);
      expect(JSON.parse(copies[0]!)).toEqual({ integrity: "ok", pages: expect.any(Number) });
      const finalGeneration = once(writer, "message");
      writer.postMessage("stop", []);
      expect((await finalGeneration)[0]).toBeGreaterThan(1);
    } finally {
      writer.postMessage("stop", []);
      await exited;
    }
    const { DatabaseSync } = requireNodeSqlite();
    const verified = new DatabaseSync(source, { readOnly: true });
    try {
      expect(verified.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      verified.close();
    }
  });

  it.each([
    { outcome: "accepts compatible", version: OPENCLAW_AGENT_SCHEMA_VERSION, refusal: false },
    { outcome: "refuses newer", version: OPENCLAW_AGENT_SCHEMA_VERSION + 1, refusal: true },
  ])("$outcome agent schemas committed to active WAL", async ({ version, refusal }) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-wal-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
    openOpenClawStateDatabase({ env });
    const agentPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    // Capture before opening the writer: closing another main-file descriptor
    // in its process would release the writer's POSIX locks.
    const databaseBefore = fs.readFileSync(agentPath);
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      agent.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      // Keep the committed schema change in WAL while the connection remains open.
      agent.exec(`PRAGMA user_version = ${version};`);
      const walBefore = fs.readFileSync(`${agentPath}-wal`);
      expect(databaseBefore.readUInt32BE(60)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      expect(walBefore.length).toBeGreaterThan(32);

      const result = await checkTargetDatabaseSchemasForContexts(
        { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
        [{ config, env }],
      );

      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual(
        refusal
          ? [
              expect.objectContaining({
                kind: "agent",
                path: agentPath,
                foundVersion: version,
                supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
              }),
            ]
          : [],
      );
      expect(hasSchemaRefusal(result)).toBe(refusal);
      expect(fs.readFileSync(agentPath)).toEqual(databaseBefore);
      expect(fs.readFileSync(`${agentPath}-wal`)).toEqual(walBefore);
    } finally {
      agent.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "deduplicates caller and managed aliases of one physical database",
    async () => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-union-state-"));
      const aliasRoot = tempDirs.make("openclaw-update-union-alias-");
      const stateAlias = path.join(aliasRoot, "state-link");
      fs.symlinkSync(stateDir, stateAlias, "dir");
      const statePath = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }).path;
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const state = new DatabaseSync(statePath);
      state.exec("PRAGMA user_version = 9;");
      state.close();
      const config: OpenClawConfig = {};

      const result = await checkTargetDatabaseSchemasForContexts({ state: 3, agent: 11 }, [
        { config, env: { OPENCLAW_STATE_DIR: stateDir } },
        { config, env: { OPENCLAW_STATE_DIR: stateAlias } },
      ]);

      expect(result.incompatible).toEqual([
        expect.objectContaining({ kind: "state", path: statePath, foundVersion: 9 }),
      ]);
      expect(result.indeterminate).toEqual([]);
    },
  );

  it("refuses v2026.8.1 before mutating v2026.7.1-2 shared state when an agent store is unreadable", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-7-to-8-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = { agents: { list: [{ id: "main" }, { id: "worker" }] } };
    const statePath = openOpenClawStateDatabase({ env }).path;
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    unregisterOpenClawAgentDatabase({ agentId: "worker", env, path: agentPath });
    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    state.exec("PRAGMA user_version = 1; UPDATE schema_meta SET schema_version = 1;");
    state.close();
    fs.writeFileSync(agentPath, "damaged v2026.7.1-2 agent store\n");
    const stateBefore = fs.readFileSync(statePath);

    const result = await checkTargetDatabaseSchemasForContexts(
      // Published v2026.8.1 supports state schema 15 and agent schema 19.
      { state: 15, agent: 19 },
      [{ config, env }],
    );

    expect(result.incompatible).toEqual([]);
    expect(result.indeterminate).toEqual([
      expect.objectContaining({ kind: "agent", path: agentPath }),
    ]);
    expect(hasSchemaRefusal(result)).toBe(true);
    expect(fs.readFileSync(statePath)).toEqual(stateBefore);
    const inspectedState = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(inspectedState.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      inspectedState.close();
    }
  });

  it("finds every multi-agent store before refusing a v2026.7.1-2 target", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-preflight-state-"));
    const customDir = fs.realpathSync.native(tempDirs.make("openclaw-update-preflight-custom-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "configured" }] },
    };
    openOpenClawStateDatabase({ env });
    const configuredPath = openOpenClawAgentDatabase({ agentId: "configured", env }).path;
    const unregisteredPath = openOpenClawAgentDatabase({ agentId: "retired", env }).path;
    const registeredCustomPath = openOpenClawAgentDatabase({
      agentId: "registered-custom",
      env,
      path: path.join(customDir, "registered", "openclaw-agent.sqlite"),
    }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    unregisterOpenClawAgentDatabase({ agentId: "retired", env, path: unregisteredPath });

    const before = [configuredPath, unregisteredPath, registeredCustomPath].map((pathname) => ({
      pathname,
      bytes: fs.readFileSync(pathname),
      mtimeNs: fs.statSync(pathname, { bigint: true }).mtimeNs,
    }));
    const result = await checkTargetDatabaseSchemasForContexts(
      // v2026.7.1-2 supports state/agent schema 1. The reported upgrade to
      // v2026.8.1 advances them to state 15 and agent 19.
      { state: 1, agent: 1 },
      [{ config, env }],
    );

    const incompatibleAgentPaths = result.incompatible
      .filter((database) => database.kind === "agent")
      .map((database) => database.path)
      .toSorted();
    expect(incompatibleAgentPaths).toEqual(
      [configuredPath, unregisteredPath, registeredCustomPath].toSorted(),
    );
    expect(result.indeterminate).toEqual([]);
    expect(hasSchemaRefusal(result)).toBe(true);
    expect(
      before.map(({ pathname }) => ({
        pathname,
        bytes: fs.readFileSync(pathname),
        mtimeNs: fs.statSync(pathname, { bigint: true }).mtimeNs,
      })),
    ).toEqual(before);
  });

  it("finds configured custom stores without registry rows", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-state-"));
    const customDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-root-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "ops" }] },
      session: { store: path.join(customDir, "{agentId}", "sessions.json") },
    };
    openOpenClawStateDatabase({ env });
    const customPaths = ["main", "ops"].map(
      (agentId) =>
        openOpenClawAgentDatabase({
          agentId,
          env,
          path: path.join(customDir, agentId, "openclaw-agent.sqlite"),
        }).path,
    );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    for (const [index, pathname] of customPaths.entries()) {
      unregisterOpenClawAgentDatabase({
        agentId: index === 0 ? "main" : "ops",
        env,
        path: pathname,
      });
    }

    const result = await checkTargetDatabaseSchemasForContexts({ state: 1, agent: 1 }, [
      { config, env },
    ]);

    expect(result.incompatible.filter((database) => database.kind === "agent")).toEqual(
      expect.arrayContaining(
        customPaths.map((pathname) => expect.objectContaining({ path: pathname })),
      ),
    );
    expect(result.indeterminate).toEqual([]);
  });
});

describe("planned legacy configuration admission", () => {
  it.each(["unchanged", "root edit", "include edit", "different profile"] as const)(
    "preserves original config and fences %s",
    async (scenario) => {
      await withTempHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { $include: "gateway.json" },
          });
          const includePath = path.join(path.dirname(configPath), "gateway.json");
          fs.writeFileSync(includePath, '{"mode":"local","bind":"localhost"}\n');
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
          const original = fs.readFileSync(configPath);
          const originalInclude = fs.readFileSync(includePath);
          const { snapshot, writeOptions } = await createConfigIO({
            env,
            observe: false,
          }).readConfigFileSnapshotForWrite();
          expect(snapshot.valid).toBe(false);
          const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
          expect(legacyConfigPlan).toBeDefined();
          await expect(
            captureTargetDatabaseSchemaContext(env).then(() => true),
          ).rejects.toMatchObject({
            reason: "invalid-config",
            message: expect.stringMatching(/gateway\.bind:[\s\S]*openclaw doctor --fix/),
          });
          // Exercise the real caller admission forwarding, without inspecting a live service.
          const { contexts } = await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, () =>
            inspectUpdateDatabaseContexts({
              roots: [],
              updateInstallKind: "package",
              shouldRestart: false,
              jsonMode: true,
              timeoutMs: 1_000,
              managedServiceRootRedirect: null,
              legacyConfigPlan,
            }),
          );
          const context = contexts[0]!;
          expect(context.config.gateway?.bind).toBe("loopback");
          expect(context.configSnapshot.valid).toBe(false);
          expect(context.configSnapshot.raw).toBe(original.toString());
          expect(fs.readFileSync(configPath)).toEqual(original);
          expect(fs.readFileSync(includePath)).toEqual(originalInclude);
          expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
          if (scenario === "unchanged") {
            expect((await revalidateUpdateDatabaseContext(context)).config).toEqual(context.config);
          } else if (scenario === "different profile") {
            const otherPath = path.join(path.dirname(configPath), "other.json");
            fs.writeFileSync(otherPath, original);
            await expect(
              captureTargetDatabaseSchemaContext(
                { ...env, OPENCLAW_CONFIG_PATH: otherPath },
                { legacyConfigPlan },
              ).then(() => true),
            ).rejects.toMatchObject({ reason: "invalid-config" });
          } else {
            fs.appendFileSync(scenario === "root edit" ? configPath : includePath, "\n");
            await expect(
              revalidateUpdateDatabaseContext(context).then(() => true),
            ).rejects.toMatchObject({
              reason: "database-schema-preflight",
            });
          }
        });
      });
    },
  );
});

describe("planned migration managed profile isolation", () => {
  it("reports invalid model policy paths without disclosing their values", async () => {
    await withTempHome(async (home) => {
      const rejectedValue = "synthetic-private-config-value";
      const configPath = await writeOpenClawConfig(home, {
        agents: { defaults: { modelPolicy: { allow: [rejectedValue] } } },
      });
      const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
      const before = fs.readFileSync(configPath);
      const inspected = captureTargetDatabaseSchemaContext(env);
      await expect(inspected).rejects.toMatchObject({ reason: "invalid-config" });
      await expect(inspected).rejects.toThrow("agents.defaults.modelPolicy.allow.0:");
      await expect(inspected).rejects.toThrow("openclaw doctor --fix");
      await expect(inspected).rejects.not.toThrow(rejectedValue);
      expect(fs.readFileSync(configPath)).toEqual(before);
    });
  });

  it("refuses a newly valid replacement of the planned source before admission", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", bind: "localhost" },
      });
      const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
      const { snapshot, writeOptions } = await createConfigIO({
        env,
        observe: false,
      }).readConfigFileSnapshotForWrite();
      const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
      expect(legacyConfigPlan).toBeDefined();
      const replacement = JSON.stringify({ gateway: { mode: "local", bind: "lan" } });
      fs.writeFileSync(configPath, replacement);
      await expect(
        captureTargetDatabaseSchemaContext(env, { legacyConfigPlan }),
      ).rejects.toMatchObject({
        reason: "database-schema-preflight",
      });
      expect(fs.readFileSync(configPath, "utf8")).toBe(replacement);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    });
  });

  it.each([
    "same source",
    "other valid source",
    "other legacy source",
    "other invalid source",
  ] as const)("admits only the owned service's config: %s", async (scenario) => {
    await withTempHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const callerPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", bind: "localhost" },
        });
        const callerEnv = { ...process.env, OPENCLAW_CONFIG_PATH: callerPath };
        const { snapshot, writeOptions } = await createConfigIO({
          env: callerEnv,
          observe: false,
        }).readConfigFileSnapshotForWrite();
        const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
        expect(legacyConfigPlan).toBeDefined();
        const servicePath =
          scenario === "same source"
            ? callerPath
            : path.join(path.dirname(callerPath), "service.json");
        if (servicePath !== callerPath) {
          fs.writeFileSync(
            servicePath,
            JSON.stringify({
              gateway: {
                mode: "local",
                bind: scenario === "other legacy source" ? "localhost" : "lan",
                ...(scenario === "other invalid source" ? { port: "invalid" } : {}),
              },
            }),
          );
        }
        const before = fs.readFileSync(servicePath);
        const serviceEnv = { ...callerEnv, OPENCLAW_CONFIG_PATH: servicePath };
        const originalEnv = { ...process.env };
        const inspected = captureOwnedManagedUpdatePreflightContext({
          processEnv: callerEnv,
          legacyConfigPlan,
          stopState: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv,
            serviceDefinitionEnv: serviceEnv,
            serviceUpdateVerdict: {
              kind: "owned",
              root: "/synthetic/openclaw",
              fingerprint: "owned",
              refreshDefinition: false,
            },
          },
        });
        if (scenario === "other legacy source" || scenario === "other invalid source") {
          await expect(inspected).rejects.toMatchObject({ reason: "invalid-config" });
        } else {
          const context = await inspected;
          expect(context?.config.gateway?.bind).toBe(
            scenario === "same source" ? "loopback" : "lan",
          );
          expect(context?.configSnapshot.path).toBe(servicePath);
          expect(context?.configSnapshot.valid).toBe(scenario !== "same source");
          if (scenario === "other valid source") {
            expect(context?.legacyConfigPlan).toBeUndefined();
          }
        }
        expect(fs.readFileSync(servicePath)).toEqual(before);
        expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
        expect({ ...process.env }).toEqual(originalEnv);
      });
    });
  });

  it("reports invalid fields and repair guidance without admitting unrelated invalid settings", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", bind: "localhost", port: "invalid" },
          session: { store: 42 },
        });
        const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
        const before = fs.readFileSync(configPath);
        const { snapshot, writeOptions } = await createConfigIO({
          env,
          observe: false,
        }).readConfigFileSnapshotForWrite();
        const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
        expect(legacyConfigPlan).toBeUndefined();
        const inspected = captureTargetDatabaseSchemaContext(env, { legacyConfigPlan });
        await expect(inspected).rejects.toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining(configPath),
        });
        await expect(inspected).rejects.toThrow("gateway.port:");
        await expect(inspected).rejects.toThrow("session.store:");
        await expect(inspected).rejects.toThrow("openclaw doctor --fix");
        expect(fs.readFileSync(configPath)).toEqual(before);
      });
    });
  });
});
