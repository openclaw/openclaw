import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveDatabaseEngineInput } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("host database engine selection", () => {
  it("captures a frozen connection from the supplied host environment", async () => {
    const input = await resolveDatabaseEngineInput(
      {
        database: {
          engine: "postgres",
          postgres: { connection: { source: "env", provider: "default", id: "TEST_DATABASE_DSN" } },
        },
      },
      { TEST_DATABASE_DSN: "postgresql://localhost/synthetic" },
    );
    expect(input).toEqual({
      connection: "postgresql://localhost/synthetic",
      schemaPrefix: "openclaw",
    });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("refuses a store-backed secret before opening shared state", async () => {
    await expect(
      resolveDatabaseEngineInput({
        database: {
          engine: "postgres",
          postgres: { connection: { source: "store", provider: "default", id: "database-dsn" } },
        },
      }),
    ).rejects.toThrow(/store-backed SecretRef/);
  });
  it("defaults to SQLite and does not resolve unused PostgreSQL credentials", async () => {
    await expect(resolveDatabaseEngineInput({})).resolves.toBeUndefined();
    await expect(
      resolveDatabaseEngineInput({
        database: {
          engine: "sqlite",
          postgres: { connection: { source: "file", provider: "missing", id: "/dsn" } },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves a file SecretRef on the host with the configured prefix", async () => {
    const file = path.join(tempDirs.make("workboard-database-secret-"), "connection.json");
    const connection = "postgresql://localhost/workboard_fixture";
    fs.writeFileSync(file, JSON.stringify({ dsn: connection }), { mode: 0o600 });
    await expect(
      resolveDatabaseEngineInput({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "file", provider: "database", id: "/dsn" },
            schemaPrefix: "fixture",
          },
        },
        secrets: { providers: { database: { source: "file", path: file } } },
      }),
    ).resolves.toEqual({ connection, schemaPrefix: "fixture" });
  });

  it.each([
    undefined,
    { connection: { source: "file", provider: "missing", id: "/dsn" } },
  ] as const)(
    "refuses missing or unresolved PostgreSQL connections without fallback %#",
    async (postgres) => {
      await expect(
        resolveDatabaseEngineInput({ database: { engine: "postgres", postgres } }),
      ).rejects.toThrow(/database.postgres.connection.*(?:Configure|configured)/);
    },
  );
});
