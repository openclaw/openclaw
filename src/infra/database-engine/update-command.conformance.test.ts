import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installFreshUpdateFixture } from "../../cli/update-cli/update-command-fresh.test-support.js";
import * as packageUpdate from "../../cli/update-cli/update-command-package.js";
import * as servicePlan from "../../cli/update-cli/update-command-service-plan.js";
import { updateCommand } from "../../cli/update-cli/update-command.js";
import type { OpenClawConfig } from "../../config/types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

function anchorTables(databasePath: string) {
  using anchor = openNodeSqliteDatabase(databasePath, { readOnly: true });
  return anchor.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
}

describe.skipIf(!connection)("PostgreSQL updater command admission", () => {
  const { fixture } = installFreshUpdateFixture();

  it.each([false, true])(
    "settles update refusal in the selected PostgreSQL ledger (managed profile=%s)",
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
        vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(true);
        vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue({
          installed: true,
          loadState: { status: "loaded" },
          running: false,
          env,
          command: {
            programArguments: [
              process.execPath,
              path.join(fixture.root, "dist", "index.js"),
              "gateway",
            ],
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
      const config = {
        plugins: { enabled: false },
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "OPENCLAW_UPDATE_TEST_DSN" },
            schemaPrefix: `update_command_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          },
        },
      } satisfies OpenClawConfig;
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
        expect(getDatabaseEngineSelection()).toBeUndefined();
        const before = anchorTables(databasePath);
        expect(before).toEqual([{ name: "openclaw_engine_anchor" }]);

        await expect(
          updateCommand({ tag: "main", yes: true, json: true, restart: false }),
        ).rejects.toMatchObject({ code: 1 });
        expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "error", reason: "unsupported-package-target" }),
        );

        expect(
          (await client.query(`SELECT phase, status, reason FROM "${namespace}".update_runs`)).rows,
        ).toEqual([{ phase: "finished", status: "failed", reason: "unsupported-package-target" }]);
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
        expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(raw);
        expect(anchorTables(databasePath)).toEqual(before);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        if (managedProfile) {
          expect(env).not.toHaveProperty("OPENCLAW_UPDATE_TEST_DSN");
          await expect(fs.stat(fixture.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        try {
          if (namespace) {
            await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
          }
        } finally {
          await client.end();
          resetDatabaseEngineSelectionForTest();
        }
      }
    },
  );

  it("refuses an unresolved PostgreSQL connection before creating native state", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "OPENCLAW_UPDATE_TEST_DSN" },
          },
        },
      }),
    );
    vi.stubEnv("OPENCLAW_UPDATE_TEST_DSN", undefined);
    await expect(
      updateCommand({ tag: "main", yes: true, json: true, restart: false }),
    ).rejects.toThrow(/resolvable PostgreSQL DSN/);
    await expect(fs.stat(fixture.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(getDatabaseEngineSelection()).toBeUndefined();
  });

  it("refuses unreadable configuration before defaulting to native state", async () => {
    await fs.mkdir(process.env.OPENCLAW_CONFIG_PATH!, { recursive: true });
    await expect(
      updateCommand({ tag: "main", yes: true, json: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "error",
        reason: "config-read-failed",
        failedStep: expect.objectContaining({
          name: "config-read-failed",
          failureFacts: [expect.objectContaining({ check: "config", code: "EISDIR" })],
        }),
      }),
    );
    await expect(fs.stat(fixture.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(getDatabaseEngineSelection()).toBeUndefined();
  });
});
