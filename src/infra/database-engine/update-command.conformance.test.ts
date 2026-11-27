import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as shared from "../../cli/update-cli/shared.js";
import { updateStatusCommand } from "../../cli/update-cli/status.js";
import { updateFinalizeCommand } from "../../cli/update-cli/update-command-finalize.js";
import { installFreshUpdateFixture } from "../../cli/update-cli/update-command-fresh.test-support.js";
import * as packageUpdate from "../../cli/update-cli/update-command-package.js";
import * as servicePlan from "../../cli/update-cli/update-command-service-plan.js";
import { updateCommand } from "../../cli/update-cli/update-command.js";
import { updateRepairCommand } from "../../cli/update-cli/update-repair-command.js";
import * as configReader from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptEvent } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { OpenClawConfig } from "../../config/types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { cleanupPostgresStateFixture } from "../../state/openclaw-state-db.postgres-fixture.test-support.js";
import { recordDeferredPluginMigrations } from "../deferred-plugin-migrations.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { createSessionSqliteMigrationRun } from "../session-sqlite-migration-manifest.js";
import * as updateCheck from "../update-check.js";
import { createUpdateRun, finishUpdateRun } from "../update-run-ledger.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const connectionRef = {
  source: "env",
  provider: "default",
  id: "OPENCLAW_UPDATE_TEST_DSN",
} as const;
const postgresConfig = (): OpenClawConfig => ({
  plugins: { enabled: false },
  database: { engine: "postgres", postgres: { connection: connectionRef } },
});
const update = (tag = "main") => updateCommand({ tag, yes: true, json: true, restart: false });

function anchorTables(databasePath: string) {
  using anchor = openNodeSqliteDatabase(databasePath, { readOnly: true });
  return anchor.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
}

describe("PostgreSQL updater command admission", () => {
  const { fixture } = installFreshUpdateFixture();
  async function expectNoNativeState() {
    await expect(fs.stat(fixture.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(getDatabaseEngineSelection()).toBeUndefined();
  }

  it.skipIf(!connection)(
    "reads both migration warning sources from the configured PostgreSQL stores",
    async () => {
      installDatabaseProcessRole("cli-oneshot");
      vi.stubEnv("OPENCLAW_UPDATE_TEST_DSN", connection);
      const config = postgresConfig();
      const stateDir = process.env.OPENCLAW_STATE_DIR!;
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
      vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
        root: fixture.root,
        installKind: "package",
        packageManager: "npm",
      });
      vi.spyOn(await import("../../gateway/call.js"), "callGateway").mockRejectedValue(
        new Error("Offline status proof"),
      );
      const service = await import("../../daemon/service.js");
      vi.spyOn(service, "resolveGatewayService").mockReturnValue({
        ...service.resolveGatewayService(),
        readCommand: async () => null,
      });
      const client = new Client({ connectionString: connection });
      await client.connect();
      const databasePath = resolveOpenClawStateSqlitePath();
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:recovered";
      const namespaces: string[] = [];
      resetDatabaseEngineSelectionForTest();
      try {
        const selection = await resolveDatabaseEngineSelection(config, process.env);
        const run = await withDatabaseEngineSelection(selection, async () => {
          namespaces.push(getPostgresPhysicalFacts(openOpenClawStateDatabase().db)!.namespace);
          const createdRun = createUpdateRun({ trigger: "cli" });
          finishUpdateRun(createdRun.runId, { status: "succeeded" });
          await recordDeferredPluginMigrations({
            pending: [
              {
                pluginId: "sample",
                reason: "Upgrade unfinished.",
                command: "openclaw doctor --fix",
              },
            ],
          });
          const scope = { agentId: "main", sessionKey, storePath };
          await replaceSessionEntry(scope, { sessionId: "recovered", updatedAt: 1 });
          await appendTranscriptEvent(
            { ...scope, sessionId: "recovered" },
            { type: "session", id: "recovered", version: 3 },
          );
          namespaces.push(
            getPostgresPhysicalFacts(openOpenClawAgentDatabase({ agentId: "main" }).db)!.namespace,
          );
          await closeOpenClawAgentDatabasesAsync();
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          return createdRun;
        });
        const resolved = {
          code: "transcript_missing",
          sessionKey,
          message: `Transcript file is missing: ${path.join(path.dirname(storePath), "recovered.jsonl")}`,
        };
        const unresolved = { code: "entry_invalid", message: "Missing sessionId." };
        const { manifest, manifestPath } = createSessionSqliteMigrationRun(process.env, [
          { agentId: "main", sqlitePath: agentPath, storePath },
        ]);
        manifest.completedAt = manifest.startedAt;
        Object.assign(manifest.targets[0]!, {
          issues: [resolved, unresolved],
          validationBeforeArchive: "passed",
        });
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        const original = await fs.readFile(manifestPath);
        expect(getDatabaseEngineSelection()).toBeUndefined();

        await updateStatusCommand({ json: true });

        expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
          lastRun: { runId: run.runId },
          migrationWarnings: [
            expect.stringContaining("Upgrade unfinished."),
            `${storePath}: [entry_invalid] Missing sessionId.`,
          ],
        });
        expect(getDatabaseEngineSelection()).toBeUndefined();
        expect(await fs.readFile(manifestPath)).toEqual(original);
        expect(anchorTables(databasePath)).toEqual([{ name: "openclaw_engine_anchor" }]);
        expect(anchorTables(agentPath)).toEqual([{ name: "openclaw_engine_anchor" }]);

        await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, "{");
        await updateStatusCommand({ json: true });
        const unavailable = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
        expect(unavailable).toHaveProperty("migrationWarningsError", expect.any(String));
        expect(unavailable).not.toHaveProperty("migrationWarnings");
        expect(await fs.readFile(manifestPath)).toEqual(original);
        expect(getDatabaseEngineSelection()).toBeUndefined();
      } finally {
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        for (const namespace of namespaces) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
        resetDatabaseEngineSelectionForTest();
        await client.end();
      }
    },
  );

  it.skipIf(!connection).each([false, true])(
    "settles update and repair refusals in the selected PostgreSQL ledger (managed profile=%s)",
    async (managedProfile) => {
      if (!managedProfile) {
        vi.stubEnv("OPENCLAW_UPDATE_TEST_DSN", connection);
      }
      const selectedState = managedProfile
        ? path.join(path.dirname(fixture.root), "managed-profile")
        : process.env.OPENCLAW_STATE_DIR!;
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: selectedState,
        OPENCLAW_CONFIG_PATH: path.join(selectedState, "openclaw.json"),
      };
      if (managedProfile) {
        const entrypoint = path.join(fixture.root, "dist", "index.js");
        vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(true);
        vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue({
          installed: true,
          loadState: { status: "loaded" },
          running: false,
          env,
          command: {
            programArguments: [process.execPath, entrypoint, "gateway"],
            environment: env,
          },
          verdict: {
            kind: "owned",
            root: fixture.root,
            fingerprint: "synthetic-managed-service",
            refreshDefinition: true,
          },
        });
      }
      const config = postgresConfig();
      await fs.mkdir(selectedState, { recursive: true });
      if (managedProfile) {
        await fs.writeFile(
          path.join(selectedState, ".env"),
          `OPENCLAW_UPDATE_TEST_DSN=${connection}\n`,
        );
      }
      // An unrelated invalid field remains candidate Doctor's responsibility.
      const raw = JSON.stringify(managedProfile ? { ...config, obsoleteSetting: true } : config);
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, raw);
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const client = new Client({ connectionString: connection });
      await client.connect();
      let namespace: string | undefined;
      resetDatabaseEngineSelectionForTest();
      try {
        const selection = await resolveDatabaseEngineSelection(config, {
          ...env,
          OPENCLAW_UPDATE_TEST_DSN: connection,
        });
        await withDatabaseEngineSelection(selection, async () => {
          namespace = withEngineStoreAdmission(
            () => getPostgresPhysicalFacts(openOpenClawStateDatabase({ env }).db)?.namespace,
          );
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
        });
        assert(namespace);
        const before = anchorTables(databasePath);
        expect(before).toEqual([{ name: "openclaw_engine_anchor" }]);

        await expect(update()).rejects.toMatchObject({ code: 1 });
        expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall).toMatchObject([
          { status: "error", reason: "unsupported-package-target" },
        ]);
        expect(
          (await client.query(`SELECT phase, status, reason FROM "${namespace}".update_runs`)).rows,
        ).toEqual([{ phase: "finished", status: "failed", reason: "unsupported-package-target" }]);
        if (!managedProfile) {
          vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
          for (const command of [updateRepairCommand, updateFinalizeCommand]) {
            const failure = new Error("Synthetic configuration failure after repair preflight");
            vi.spyOn(configReader, "readConfigFileSnapshot").mockRejectedValueOnce(failure);
            await expect(command({ channel: "dev", yes: true, json: true })).rejects.toBe(failure);
          }
          expect(
            (await client.query(`SELECT 1 FROM "${namespace}".update_runs`)).rows,
          ).toHaveLength(3);
        }
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
        expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(raw);
        expect(anchorTables(databasePath)).toEqual(before);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        if (managedProfile) {
          expect(env).not.toHaveProperty("OPENCLAW_UPDATE_TEST_DSN");
          await expectNoNativeState();
        }
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        await cleanupPostgresStateFixture(client, databasePath, namespace);
      }
    },
  );

  it.each(["main", "latest"])(
    "refuses an unresolved PostgreSQL connection before creating native state (tag=%s)",
    async (tag) => {
      const configPath = process.env.OPENCLAW_CONFIG_PATH!;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ database: postgresConfig().database }));
      vi.stubEnv("OPENCLAW_UPDATE_TEST_DSN", undefined);
      await expect(update(tag)).rejects.toThrow(/resolvable PostgreSQL DSN/);
      await expectNoNativeState();
    },
  );

  it.each(["main", "latest"])(
    "refuses unreadable configuration before defaulting to native state (tag=%s)",
    async (tag) => {
      await fs.mkdir(process.env.OPENCLAW_CONFIG_PATH!, { recursive: true });
      await expect(update(tag)).rejects.toMatchObject({ code: 1 });
      expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall).toMatchObject([
        {
          status: "error",
          reason: "config-read-failed",
          failedStep: {
            name: "config-read-failed",
            failureFacts: [{ check: "config", code: "EISDIR" }],
          },
        },
      ]);
      await expectNoNativeState();
    },
  );
});
