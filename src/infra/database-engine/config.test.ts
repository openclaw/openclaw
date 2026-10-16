import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveDatabaseEngineInput, resolveDatabaseEngineSelection } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const sqliteEngines = {
  state: "sqlite",
  agent: "sqlite",
  workboard: "sqlite",
  logbook: "sqlite",
  "team-reports": "sqlite",
  quarantine: "sqlite",
  "managed-update": "sqlite",
  "package-activation": "sqlite",
};

describe("host database engine selection", () => {
  it.each([undefined, "sqlite"] as const)(
    "keeps the public resolver on the default engine (%s), regardless of family overrides",
    async (engine) => {
      await expect(
        resolveDatabaseEngineInput({
          database: {
            engine,
            families: { state: { engine: "postgres" } },
            postgres: { connection: { source: "file", provider: "missing", id: "/dsn" } },
          },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("preserves the public PostgreSQL default even when built-in families override to SQLite", async () => {
    await expect(
      resolveDatabaseEngineInput({
        database: {
          engine: "postgres",
          families: {
            state: { engine: "sqlite" },
            agent: { engine: "sqlite" },
            workboard: { engine: "sqlite" },
            logbook: { engine: "sqlite" },
            "team-reports": { engine: "sqlite" },
          },
          postgres: { connection: "postgresql://localhost/synthetic" },
        },
      }),
    ).resolves.toEqual({
      connection: "postgresql://localhost/synthetic",
      schemaPrefix: "openclaw",
    });
  });

  it("captures a frozen connection from the supplied host environment for an override", async () => {
    const selection = await resolveDatabaseEngineSelection(
      {
        database: {
          engine: "sqlite",
          families: { state: { engine: "postgres" }, agent: { engine: "sqlite" } },
          postgres: { connection: { source: "env", provider: "default", id: "TEST_DATABASE_DSN" } },
        },
      },
      { TEST_DATABASE_DSN: "postgresql://localhost/synthetic" },
    );
    expect(selection).toEqual({
      effectiveEngines: { ...sqliteEngines, state: "postgres" },
      postgres: { connection: "postgresql://localhost/synthetic", schemaPrefix: "openclaw" },
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.effectiveEngines)).toBe(true);
    expect(Object.isFrozen(selection.postgres)).toBe(true);
  });

  it("refuses a store-backed secret before opening shared state", async () => {
    await expect(
      resolveDatabaseEngineSelection({
        database: {
          families: { workboard: { engine: "postgres" } },
          postgres: { connection: { source: "store", provider: "default", id: "database-dsn" } },
        },
      }),
    ).rejects.toThrow(/store-backed SecretRef/);
  });

  it("defaults to SQLite and does not resolve unused PostgreSQL credentials", async () => {
    await expect(resolveDatabaseEngineSelection({})).resolves.toEqual({
      effectiveEngines: sqliteEngines,
    });
    await expect(
      resolveDatabaseEngineSelection({
        database: {
          engine: "sqlite",
          postgres: { connection: { source: "file", provider: "missing", id: "/dsn" } },
        },
      }),
    ).resolves.toEqual({ effectiveEngines: sqliteEngines });
  });

  it("applies the PostgreSQL default only to capable families and honors SQLite overrides", async () => {
    await expect(
      resolveDatabaseEngineSelection({
        database: {
          engine: "postgres",
          families: { workboard: { engine: "sqlite" }, agent: { engine: "sqlite" } },
          postgres: { connection: "postgresql://localhost/synthetic" },
        },
      }),
    ).resolves.toEqual({
      effectiveEngines: {
        ...sqliteEngines,
        state: "postgres",
        logbook: "postgres",
        "team-reports": "postgres",
      },
      postgres: { connection: "postgresql://localhost/synthetic", schemaPrefix: "openclaw" },
    });
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
    "refuses missing or unresolved PostgreSQL connections for a family override %#",
    async (postgres) => {
      await expect(
        resolveDatabaseEngineSelection({
          database: { engine: "sqlite", families: { workboard: { engine: "postgres" } }, postgres },
        }),
      ).rejects.toThrow(/database.postgres.connection.*(?:Configure|configured)/);
    },
  );
});
