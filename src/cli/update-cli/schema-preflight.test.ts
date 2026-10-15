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
import { reconstructAgentDeletionJournal } from "../../state/agent-deletion-journal-recovery.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { captureOwnedManagedUpdatePreflightContext } from "./update-command-managed-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("target-release database schema preflight", () => {
  it("admits matching caller and service contexts while a writer keeps committing", async () => {
    const home = fs.realpathSync.native(tempDirs.make("update-busy-preflight-"));
    const stateDir = path.join(home, ".openclaw");
    const callerEnv = { HOME: home };
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const source = openOpenClawStateDatabase({ env }).path;
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
      const result = await checkTargetDatabaseSchemasForContexts(
        { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
        [
          { config: {}, env: callerEnv },
          { config: {}, env: { ...env } },
        ],
      );
      expect(result).toEqual({ incompatible: [], indeterminate: [] });
      expect(callerEnv).toEqual({ HOME: home });
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

  it.runIf(process.platform !== "win32")(
    "deduplicates alias refusals without losing their lexical import boundaries",
    async () => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-union-state-"));
      const aliasRoot = tempDirs.make("openclaw-update-union-alias-");
      const stateAlias = path.join(aliasRoot, "state-link");
      fs.symlinkSync(stateDir, stateAlias, "dir");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const statePath = openOpenClawStateDatabase({ env }).path;
      const externalDir = tempDirs.make("openclaw-update-union-external-");
      const externalPath = openOpenClawAgentDatabase({
        agentId: "external",
        env,
        path: path.join(externalDir, "openclaw-agent.sqlite"),
      }).path;
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      const importsDir = path.join(stateDir, "imports");
      fs.mkdirSync(importsDir);
      fs.symlinkSync(externalDir, path.join(importsDir, "external"), "dir");
      const registeredPath = path.join(importsDir, "external", "openclaw-agent.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const state = new DatabaseSync(statePath);
      state.exec("PRAGMA user_version = 9;");
      // Keep an absolute locator: relative registry entries inherit each root's
      // spelling and would be excluded by both contexts' lexical imports rule.
      state
        .prepare("UPDATE agent_databases SET path = ? WHERE agent_id = 'external'")
        .run(registeredPath);
      state.close();
      const external = new DatabaseSync(externalPath);
      external.exec("PRAGMA user_version = 12;");
      external.close();
      const config: OpenClawConfig = {};

      const result = await checkTargetDatabaseSchemasForContexts({ state: 3, agent: 11 }, [
        { config, env: { OPENCLAW_STATE_DIR: stateDir } },
        { config, env: { OPENCLAW_STATE_DIR: stateAlias } },
      ]);

      expect(result.incompatible).toEqual([
        expect.objectContaining({ kind: "state", path: statePath, foundVersion: 9 }),
        expect.objectContaining({ kind: "agent", path: registeredPath, foundVersion: 12 }),
      ]);
      expect(result.indeterminate).toEqual([]);
    },
  );

  it("refuses v2026.8.1 before mutating v2026.7.1-2 shared state when an agent store is unreadable", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-7-to-8-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
    };
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

  it("unions custom stores across matching contexts and observes deletion holds at the next checkpoint", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-state-"));
    const customDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-root-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const serviceHome = fs.realpathSync.native(tempDirs.make("openclaw-update-service-home-"));
    const agents = { ownership: "explicit" as const, entries: { main: {}, ops: {} } };
    const contexts = [
      {
        config: {
          agents,
          session: { store: path.join(customDir, "{agentId}", "sessions.json") },
        },
        env,
      },
      {
        config: { agents, session: { store: "~/custom/{agentId}/sessions.json" } },
        env: { ...env, HOME: serviceHome },
      },
    ];
    openOpenClawStateDatabase({ env });
    const customTargets = [customDir, path.join(serviceHome, "custom")].flatMap((directory) =>
      ["main", "ops"].map((agentId) => ({
        agentId,
        path: openOpenClawAgentDatabase({
          agentId,
          env,
          path: path.join(directory, agentId, "openclaw-agent.sqlite"),
        }).path,
      })),
    );
    closeOpenClawAgentDatabasesForTest();
    for (const target of customTargets) {
      unregisterOpenClawAgentDatabase({ ...target, env });
    }
    await closeOpenClawStateDatabaseAsync();
    const customPaths = customTargets.map((target) => target.path);

    const result = await checkTargetDatabaseSchemasForContexts({ state: 1, agent: 1 }, contexts);

    const agentPaths = (schemas: typeof result) =>
      schemas.incompatible
        .filter((database) => database.kind === "agent")
        .map((database) => database.path);
    expect(agentPaths(result)).toEqual(customPaths);
    expect(result.indeterminate).toEqual([]);
    const held = customTargets.at(-1)!;
    const heldBefore = fs.readFileSync(held.path);
    runOpenClawStateWriteTransaction(
      (database) => {
        database.db.exec("DROP TABLE agent_deletion_journal");
        reconstructAgentDeletionJournal(database, [held]);
      },
      { env },
    );
    await closeOpenClawStateDatabaseAsync();
    const refreshed = await checkTargetDatabaseSchemasForContexts({ state: 1, agent: 1 }, contexts);
    expect(agentPaths(refreshed)).toEqual(customPaths.filter((pathname) => pathname !== held.path));
    expect(refreshed.indeterminate).toEqual([]);
    expect(fs.readFileSync(held.path)).toEqual(heldBefore);
    expect(env).toEqual({ OPENCLAW_STATE_DIR: stateDir });
    expect(contexts[1]?.env).toEqual({ OPENCLAW_STATE_DIR: stateDir, HOME: serviceHome });
  });
});

describe("planned legacy configuration admission", () => {
  it.each(["different profile"] as const)(
    "keeps profile ownership and authored bytes across %s",
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
          if (scenario === "different profile") {
            const otherPath = path.join(path.dirname(configPath), "other.json");
            fs.writeFileSync(otherPath, original);
            await expect(
              captureTargetDatabaseSchemaContext(
                { ...env, OPENCLAW_CONFIG_PATH: otherPath },
                { legacyConfigPlan },
              ).then(() => true),
            ).rejects.toMatchObject({ reason: "invalid-config" });
          }
        });
      });
    },
  );
});

describe("planned migration managed profile isolation", () => {
  it("admits a newly valid replacement without reusing the prior legacy plan", async () => {
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
      const current = await captureTargetDatabaseSchemaContext(env, { legacyConfigPlan });
      expect(current.config.gateway?.bind).toBe("lan");
      expect(current.configSnapshot.raw).toBe(replacement);
      expect(current.legacyConfigPlan).toBeUndefined();
      expect(fs.readFileSync(configPath, "utf8")).toBe(replacement);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    });
  });

  it.each(["other legacy source", "other invalid source"] as const)(
    "admits only the owned service's config: %s",
    async (scenario) => {
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
          const servicePath = path.join(path.dirname(callerPath), "service.json");
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
          await expect(inspected).rejects.toMatchObject({ reason: "invalid-config" });
          expect(fs.readFileSync(servicePath)).toEqual(before);
          expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
          expect({ ...process.env }).toEqual(originalEnv);
        });
      });
    },
  );
});
