import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runWorkboardPortTask } from "./port-command.worker.js";
import { readPostgresPortCapabilities } from "./port.worker.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };
import { loadWorkboardPortDescriptor } from "./workboard-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { assertCurrent() {} };
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
afterEach(() => vi.restoreAllMocks());

it.each([
  { version: 150000, encoding: "UTF8", client_encoding: "UTF8" },
  { version: 170000, encoding: "LATIN1", client_encoding: "UTF8" },
  { version: 170000, encoding: "UTF8", client_encoding: "LATIN1" },
])("rejects incompatible PostgreSQL capabilities %j at the query boundary", async (facts) => {
  const client = Object.assign(new Client({ host: "127.0.0.1", port: 1 }), {
    query: vi.fn(async () => ({
      rows: [facts],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    })),
  });
  await expect(
    readPostgresPortCapabilities(client, await loadWorkboardPortDescriptor()),
  ).rejects.toThrow("required PostgreSQL >=16 and UTF8 server/client");
});

it("redacts unresolved connection SecretRefs", async () => {
  const config: OpenClawConfig = {
    database: {
      engine: "postgres",
      postgres: {
        connection: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_PORT_TEST_UNRESOLVED_CONNECTION",
        },
      },
    },
  };
  await expect(
    runWorkboardPortTask({ operation: "preflight", config, probe: false }, scope),
  ).rejects.toThrow("preflight: workboard:");
});

describe.skipIf(!connection)("workboard port PostgreSQL refusal boundaries", () => {
  it("probes real privileges, refuses occupied/wrong-owner/RLS sources, and resumes verified staging", async (context) => {
    const client = new Client({ connectionString: connection });
    await client.connect();
    const admin = (
      await client.query(
        "SELECT current_setting('is_superuser') AS superuser, current_database() AS database",
      )
    ).rows[0];
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
    {
      using db = openNodeSqliteDatabase(sourcePath);
      db.exec(metadata.sqlite);
      db.exec(
        "INSERT INTO workboard_schema_migrations VALUES ('schema-3', 1); INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', 'private-payload', 1, 1)",
      );
    }
    const original = await hash(sourcePath);
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-port-fixture'`);
    try {
      expect(
        await runWorkboardPortTask({ operation: "preflight", config, probe: false }, scope),
      ).toMatchObject({ privilegesChecked: false });
      await expect(
        runWorkboardPortTask({ operation: "preflight", config, probe: true }, scope),
      ).rejects.toThrow("namespace privilege probe");
      await client.query(`GRANT CREATE ON DATABASE "${database}" TO "${role}"`);
      const stage = {
        operation: "stage" as const,
        sourcePath,
        targetPath,
        storeId,
        namespace,
        config,
        to: "postgres" as const,
      };
      const copied = await runWorkboardPortTask(stage, scope);
      const anchor = await hash(targetPath);
      await expect(
        runWorkboardPortTask(
          { ...stage, targetPath: path.join(directory, "occupied.sqlite") },
          scope,
        ),
      ).rejects.toThrow("occupied target namespace");
      await client.query(`ALTER SCHEMA "${namespace}" OWNER TO CURRENT_USER`);
      await expect(
        runWorkboardPortTask(
          { operation: "inspect", sourcePath: targetPath, config, to: "sqlite" },
          scope,
        ),
      ).rejects.toThrow("different owner");
      await client.query(
        `ALTER SCHEMA "${namespace}" OWNER TO "${role}"; ALTER TABLE "${namespace}".workboard_boards ENABLE ROW LEVEL SECURITY; ALTER TABLE "${namespace}".workboard_boards FORCE ROW LEVEL SECURITY; CREATE POLICY deny_port ON "${namespace}".workboard_boards USING (false)`,
      );
      const refused = await runWorkboardPortTask(
        { operation: "inspect", sourcePath: targetPath, config, to: "sqlite" },
        scope,
      ).catch((error: unknown) => error);
      if (!(refused instanceof Error)) {
        throw new Error("Expected an RLS refusal");
      }
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
        runWorkboardPortTask(
          {
            operation: "verify",
            sourcePath: targetPath,
            config,
            engine: "postgres",
            storeId,
            namespace,
            verification: copied.verification,
          },
          scope,
        ),
      ).rejects.toThrow("database validation");
      await client.query(`DROP INDEX "${namespace}".workboard_cards_session_idx`);
      await client.query(originalIndex);
      const resumed = await runWorkboardPortTask(
        { ...stage, targetPath: path.join(directory, "resumed.sqlite"), resume: true },
        scope,
      );
      expect(resumed.verification).toEqual(copied.verification);
      expect(await runWorkboardPortTask({ ...stage, resume: true }, scope)).toEqual(copied);
      expect(await hash(sourcePath)).toBe(original);
      expect(await hash(targetPath)).toBe(anchor);
    } finally {
      await client.query(`DROP OWNED BY "${role}" CASCADE; DROP ROLE "${role}"`);
      await client.end();
    }
  }, 60_000);
});
