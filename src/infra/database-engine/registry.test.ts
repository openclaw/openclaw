import { describe, expect, it } from "vitest";
import {
  assertHomogeneousDatabaseEngines,
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

  it.each(["port", "backup", "restore", "update"] as const)(
    "refuses %s for effective mixed engines regardless of the default",
    (operation) => {
      for (const database of [
        { engine: "sqlite", families: { state: { engine: "postgres" } } },
        { engine: "postgres", families: { workboard: { engine: "sqlite" } } },
      ] as const) {
        expect(() => assertHomogeneousDatabaseEngines({ database }, operation)).toThrow(
          `${operation} for mixed-engine installs is not supported yet; use a single engine`,
        );
      }
    },
  );

  it("preserves homogeneous defaults and ignores fixed-local families", () => {
    for (const database of [undefined, { engine: "sqlite" }, { engine: "postgres" }] as const) {
      expect(() => assertHomogeneousDatabaseEngines({ database }, "backup")).not.toThrow();
    }
    expect(() =>
      assertHomogeneousDatabaseEngines(
        { database: { engine: "postgres", families: { agent: { engine: "sqlite" } } } },
        "update",
      ),
    ).toThrow("update for mixed-engine installs is not supported yet");
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
    { families: { agent: { engine: "postgres" } } },
    { engine: "postgres", families: { state: { engine: "sqlite" } } },
    { engine: "postgres", families: { logbook: { engine: "sqlite" } } },
  ] as const)("refuses mixed PostgreSQL agents before runtime selection: %j", (database) => {
    expect(() => resolveDatabaseFamilyEngines({ database })).toThrow(
      "DATABASE_AGENT_MIXED_POSTGRES_UNSUPPORTED",
    );
  });

  it("allows explicit SQLite agents alongside PostgreSQL families", () => {
    expect(
      resolveDatabaseFamilyEngines({
        database: { engine: "postgres", families: { agent: { engine: "sqlite" } } },
      }),
    ).toMatchObject({ state: "postgres", agent: "sqlite", workboard: "postgres" });
  });
});
