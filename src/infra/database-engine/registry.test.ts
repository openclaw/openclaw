import { describe, expect, it } from "vitest";
import {
  listDatabaseEngineStores,
  resolveDatabaseFamilyEngines,
  selectDatabaseEngine,
} from "./registry.js";

describe("database engine selection", () => {
  it("honors explicit SQLite selection for PostgreSQL-capable stores", () => {
    expect(
      selectDatabaseEngine({ id: "state", postgres: true }, { database: { engine: "sqlite" } }),
    ).toBe("sqlite");
  });

  it("registers PostgreSQL support for completed store families", () => {
    expect(
      listDatabaseEngineStores()
        .filter((store) => store.postgres)
        .map((store) => store.id),
    ).toEqual(["state", "agent", "workboard", "logbook", "team-reports"]);
  });

  it.each([
    { engine: "postgres" },
    { engine: "postgres", families: { agent: { engine: "postgres" } } },
  ] as const)("selects PostgreSQL agents for a homogeneous configuration: %j", (database) => {
    expect(resolveDatabaseFamilyEngines({ database })).toMatchObject({
      state: "postgres",
      agent: "postgres",
      workboard: "postgres",
      logbook: "postgres",
      "team-reports": "postgres",
      quarantine: "sqlite",
    });
  });

  it.each([
    {
      database: { families: { agent: { engine: "postgres" } } },
      expected: { state: "sqlite", agent: "postgres", logbook: "sqlite" },
    },
    {
      database: { engine: "postgres", families: { state: { engine: "sqlite" } } },
      expected: { state: "sqlite", agent: "postgres", logbook: "postgres" },
    },
    {
      database: { engine: "postgres", families: { logbook: { engine: "sqlite" } } },
      expected: { state: "postgres", agent: "postgres", logbook: "sqlite" },
    },
  ] as const)("selects PostgreSQL agents independently: $database", ({ database, expected }) => {
    expect(resolveDatabaseFamilyEngines({ database })).toMatchObject(expected);
  });

  it("allows PostgreSQL state and agents with unrelated SQLite plugins", () => {
    expect(
      resolveDatabaseFamilyEngines({
        database: {
          engine: "postgres",
          families: { logbook: { engine: "sqlite" } },
        },
      }),
    ).toMatchObject({ state: "postgres", agent: "postgres", logbook: "sqlite" });
  });

  it("allows explicit SQLite agents alongside PostgreSQL families", () => {
    expect(
      resolveDatabaseFamilyEngines({
        database: { engine: "postgres", families: { agent: { engine: "sqlite" } } },
      }),
    ).toMatchObject({ state: "postgres", agent: "sqlite", workboard: "postgres" });
  });
});
