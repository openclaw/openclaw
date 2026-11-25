import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { installDatabaseProcessRole } from "./database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("plugin Doctor pagination on PostgreSQL state", () => {
  const client = new pg.Client({ connectionString: connection });
  beforeAll(async () => {
    installDatabaseProcessRole("cli-oneshot");
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it("continues after an exact key without losing keys sharing its prefix", async () => {
    await withOpenClawTestState({ label: "doctor-pagination", applyEnv: false }, async (state) => {
      await withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
          }),
          postgres: { connection: connection!, schemaPrefix: "doctor_pagination" },
        },
        async () => {
          try {
            const context = createPluginDoctorStateMigrationContext({
              pluginId: "telegram",
              config: {},
              env: state.env,
            });
            const namespace = "doctor-pagination";
            const store = context.openPluginStateKeyedStore({ namespace, maxEntries: 10 });
            for (const key of ["binding:a", "binding:a0", "binding:b", "other"]) {
              await store.register(key, { key });
            }
            const read = (after?: string, limit = 2) =>
              context.readPluginStateEntriesInKeyRange!(namespace, {
                prefix: "binding:",
                after,
                limit,
              }).map((entry) => entry.key);
            expect(read(undefined, 1)).toEqual(["binding:a"]);
            expect(read("binding:a")).toEqual(["binding:a0", "binding:b"]);
            expect(read("binding:b")).toEqual([]);
          } finally {
            await closeOpenClawStateDatabaseAsync();
            const anchorPath = path.join(state.stateDir, "state", "openclaw.sqlite");
            if (existsSync(anchorPath)) {
              using anchor = new DatabaseSync(anchorPath, { readOnly: true });
              const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get() as
                | { schema: string }
                | undefined;
              if (row) {
                await client.query(
                  `DROP SCHEMA IF EXISTS "${row.schema.replaceAll('"', '""')}" CASCADE`,
                );
              }
            }
          }
        },
      );
    });
  });
});
