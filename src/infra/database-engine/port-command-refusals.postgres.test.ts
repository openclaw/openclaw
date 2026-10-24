import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import "./database-suite-workers.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { connection, seedPortSqlite } from "./port-command.integration.test-support.js";
import { runDatabasePortTask, type DatabasePortTask } from "./port-command.worker.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

it.skipIf(!connection)(
  "refuses PostgreSQL privilege, ownership, RLS and catalog violations",
  async (context) => {
    const client = new Client({ connectionString: connection });
    await client.connect();
    const {
      rows: [admin],
    } = await client.query(
      "SELECT current_setting('is_superuser') AS superuser, current_database() AS database",
    );
    if (admin.superuser !== "on") {
      await client.end();
      context.skip("Temporary role proof requires the conformance cluster superuser");
    }
    const directory = tempDirs.make("port-postgres-refusals-");
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "target.sqlite");
    const storeId = randomUUID();
    const namespace = `port_negative_${randomUUID().replaceAll("-", "")}`;
    const role = `port_role_${randomUUID().replaceAll("-", "")}`;
    const database = String(admin.database).replaceAll('"', '""');
    const restricted = new URL(connection!);
    restricted.username = role;
    restricted.password = "synthetic-port-fixture";
    const config: OpenClawConfig = {
      database: { engine: "postgres", postgres: { connection: restricted.toString() } },
    };
    const identity = { storeId, namespace, config };
    const run = <T extends DatabasePortTask>(task: T) =>
      runDatabasePortTask(task, { assertCurrent() {} });
    const preflight = (probe: boolean) => run({ operation: "preflight", config, probe });
    const inspect = () =>
      run({ operation: "inspect", sourcePath: targetPath, config, to: "sqlite" });
    seedPortSqlite(
      sourcePath,
      `${metadata.sqlite};
      INSERT INTO workboard_schema_migrations VALUES ('schema-3', 1);
      INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', 'private-payload', 1, 1)`,
    );
    const original = await hash(sourcePath);
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-port-fixture'`);
    try {
      await preflight(false);
      await expect(preflight(true)).rejects.toThrow("namespace privilege probe");
      const stage = {
        ...identity,
        operation: "stage" as const,
        sourcePath,
        targetPath,
        to: "postgres" as const,
      };
      const stageAt = (name: string, resume = false) =>
        run({ ...stage, targetPath: path.join(directory, name), resume });
      await expect(run(stage)).rejects.toThrow("stage:");
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await client.query(`GRANT CREATE ON DATABASE "${database}" TO "${role}"`);
      const copied = await run(stage);
      const anchor = await hash(targetPath);
      await expect(stageAt("occupied.sqlite")).rejects.toThrow("occupied target namespace");
      await client.query(`ALTER SCHEMA "${namespace}" OWNER TO CURRENT_USER`);
      await expect(inspect()).rejects.toThrow("different owner");
      await client.query(
        `ALTER SCHEMA "${namespace}" OWNER TO "${role}"; ALTER TABLE "${namespace}".workboard_boards ENABLE ROW LEVEL SECURITY; ALTER TABLE "${namespace}".workboard_boards FORCE ROW LEVEL SECURITY; CREATE POLICY deny_port ON "${namespace}".workboard_boards USING (false)`,
      );
      const refused = await inspect().catch((error: unknown) => error);
      assert(refused instanceof Error, "Expected an RLS refusal");
      expect(refused.message).toContain("database validation");
      expect(refused.message).not.toContain("private-payload");
      expect(refused.message).not.toContain(restricted.toString());
      await client.query(
        `DROP POLICY deny_port ON "${namespace}".workboard_boards; ALTER TABLE "${namespace}".workboard_boards DISABLE ROW LEVEL SECURITY`,
      );
      const originalIndex = (
        await client.query<{ definition: string }>(
          "SELECT pg_get_indexdef($1::regclass) AS definition",
          [`"${namespace}".workboard_cards_session_idx`],
        )
      ).rows[0]?.definition;
      assert(originalIndex, "Fixture must have the original workboard session index");
      await client.query(
        `DROP INDEX "${namespace}".workboard_cards_session_idx; CREATE INDEX workboard_cards_session_idx ON "${namespace}".workboard_cards (run_id, session_key)`,
      );
      await expect(
        run({
          ...identity,
          operation: "verify",
          sourcePath: targetPath,
          engine: "postgres",
          verification: copied.verification,
        }),
      ).rejects.toThrow("database validation");
      await client.query(`DROP INDEX "${namespace}".workboard_cards_session_idx`);
      await client.query(originalIndex);
      const resumed = await stageAt("resumed.sqlite", true);
      expect(resumed.verification).toEqual(copied.verification);
      expect(await run({ ...stage, resume: true })).toEqual(copied);
      expect(await hash(sourcePath)).toBe(original);
      expect(await hash(targetPath)).toBe(anchor);
    } finally {
      await client.query(`DROP OWNED BY "${role}" CASCADE; DROP ROLE "${role}"`);
      await client.end();
    }
  },
  60_000,
);
