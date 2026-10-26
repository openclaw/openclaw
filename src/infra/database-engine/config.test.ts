import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveDatabaseEngineInput, resolveDatabaseEngineSelection } from "./config.js";
import { createSqliteFamilyEngines } from "./selection-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const connection = "postgresql://localhost/synthetic";
const unavailable = { connection: { source: "file", provider: "missing", id: "/dsn" } } as const;
const input = (database: OpenClawConfig["database"]) => resolveDatabaseEngineInput({ database });
const select = (database: OpenClawConfig["database"], env?: NodeJS.ProcessEnv) =>
  resolveDatabaseEngineSelection({ database }, env);

const sqliteEngines = createSqliteFamilyEngines();

describe("host database engine selection", () => {
  it.each([undefined, "sqlite", "postgres"] as const)(
    "keeps the public default independent of family overrides: %s",
    async (engine) => {
      const isPostgres = engine === "postgres";
      const sqlite = { engine: "sqlite" } as const;
      const families: NonNullable<OpenClawConfig["database"]>["families"] = isPostgres
        ? {
            state: sqlite,
            agent: sqlite,
            workboard: sqlite,
            logbook: sqlite,
            "team-reports": sqlite,
          }
        : { state: { engine: "postgres" } };
      await expect(
        input({ engine, families, postgres: isPostgres ? { connection } : unavailable }),
      ).resolves.toEqual(isPostgres ? { connection, schemaPrefix: "openclaw" } : undefined);
    },
  );

  it("captures a frozen connection from the supplied host environment for an override", async () => {
    const selection = await select(
      {
        engine: "sqlite",
        families: { state: { engine: "postgres" }, agent: { engine: "sqlite" } },
        postgres: { connection: { source: "env", provider: "default", id: "TEST_DATABASE_DSN" } },
      },
      { TEST_DATABASE_DSN: connection },
    );
    expect(selection).toEqual({
      effectiveEngines: { ...sqliteEngines, state: "postgres" },
      postgres: { connection, schemaPrefix: "openclaw" },
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.effectiveEngines)).toBe(true);
    expect(Object.isFrozen(selection.postgres)).toBe(true);
  });

  it.each([undefined, { engine: "sqlite", postgres: unavailable }] as const)(
    "defaults to SQLite without resolving unused credentials %#",
    async (database) => {
      await expect(select(database)).resolves.toEqual({ effectiveEngines: sqliteEngines });
    },
  );

  it("applies the PostgreSQL default only to capable families and honors SQLite overrides", async () => {
    await expect(
      select({
        engine: "postgres",
        families: { workboard: { engine: "sqlite" }, agent: { engine: "sqlite" } },
        postgres: { connection },
      }),
    ).resolves.toEqual({
      effectiveEngines: {
        ...sqliteEngines,
        state: "postgres",
        logbook: "postgres",
        "team-reports": "postgres",
      },
      postgres: { connection, schemaPrefix: "openclaw" },
    });
  });

  it("resolves a file SecretRef on the host with the configured prefix", async () => {
    const file = path.join(tempDirs.make("workboard-database-secret-"), "connection.json");
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
    unavailable,
    { connection: { source: "store", provider: "default", id: "database-dsn" } },
  ] as const)(
    "refuses missing, unresolved or store-backed family credentials %#",
    async (postgres) => {
      const error =
        postgres?.connection.source === "store"
          ? /store-backed SecretRef/
          : /database.postgres.connection.*(?:Configure|configured)/;
      await expect(
        select({ engine: "sqlite", families: { workboard: { engine: "postgres" } }, postgres }),
      ).rejects.toThrow(error);
    },
  );
});
