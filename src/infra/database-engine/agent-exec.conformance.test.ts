import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runAgentExecWithMock } from "../../commands/agent-exec.test-helpers.js";
import { createTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { installDatabaseProcessRole } from "./admission-scope.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { withDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);
// CLI bootstrap owns the process role; exec owns the database selection.
beforeAll(() => installDatabaseProcessRole("cli-oneshot"));
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetDatabaseEngineSelectionForTest();
  clearRuntimeConfigSnapshot();
});

it.skipIf(!connection).each(["ambient", "pinned", "temporary", "isolated"])(
  "exec writes to its own selected state store (%s)",
  async (mode) => {
    const root = directories.make("agent-exec-postgres-");
    const configPath = path.join(root, "openclaw.json");
    const schemaPrefix = `exec_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "EXEC_CONFORMANCE_DSN" },
          schemaPrefix,
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const client = new Client({ connectionString: connection });
    await client.connect();
    const countNamespaces = async () =>
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_namespace WHERE starts_with(nspname, $1)",
          [schemaPrefix],
        )
      ).rows[0]?.count;
    try {
      expect(await countNamespaces()).toBe(0);
      await withEnvAsync(
        {
          VITEST: undefined,
          NODE_ENV: undefined,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: configPath,
          EXEC_CONFORMANCE_DSN: connection,
        },
        async () => {
          const retained = mode === "ambient" || mode === "pinned";
          if (retained) {
            await withDatabaseEngineSelection(
              await resolveDatabaseEngineSelection(config),
              async () => {
                openOpenClawStateDatabase();
                await closeOpenClawStateDatabaseAsync();
              },
            );
          }
          setRuntimeConfigSnapshot(config);
          const result = await runAgentExecWithMock(
            "write a state marker",
            {
              cwd: root,
              ...(retained ? { stateDir: root } : {}),
              ...(mode === "pinned" ? { config: configPath } : {}),
              ...(mode === "isolated"
                ? { isolated: true, configOverride: [JSON.stringify(config)] }
                : {}),
            },
            createTestRuntime(),
            async () => {
              const pathname = path.join(
                process.env.OPENCLAW_STATE_DIR!,
                "state",
                "openclaw.sqlite",
              );
              const { db } = openOpenClawStateDatabase();
              db.prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              ).run("exec.proof", '"persisted"', 1);
              using local = openNodeSqliteDatabase(pathname, { readOnly: true });
              if (retained) {
                const row = local.prepare("SELECT schema FROM openclaw_engine_anchor").get() as {
                  schema: string;
                };
                expect(
                  (
                    await client.query(
                      `SELECT value_json FROM "${row.schema}".config_machine_state WHERE state_key = 'exec.proof'`,
                    )
                  ).rows,
                ).toEqual([{ value_json: '"persisted"' }]);
              } else {
                expect(
                  local
                    .prepare(
                      "SELECT value_json FROM config_machine_state WHERE state_key = 'exec.proof'",
                    )
                    .get(),
                ).toEqual({ value_json: '"persisted"' });
              }
              return { payloads: [{ text: "persisted" }], meta: { durationMs: 1 } };
            },
          );
          const namespaceCount = await countNamespaces();
          if (retained) {
            expect(namespaceCount).toBeGreaterThan(0);
          } else {
            expect(namespaceCount).toBe(0);
          }
          expect(result.envelope.error).toBeUndefined();
          expect(result.exitCode).toBe(0);
        },
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await dropPostgresTestSchemas(client, schemaPrefix);
      await client.end();
    }
  },
);
