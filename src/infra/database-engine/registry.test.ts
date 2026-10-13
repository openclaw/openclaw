import { describe, expect, it } from "vitest";
import { listDatabaseEngineStores, selectDatabaseEngine } from "./registry.js";

describe("database engine selection", () => {
  it("honors explicit SQLite selection for PostgreSQL-capable stores", () => {
    expect(selectDatabaseEngine({ postgres: true }, { database: { engine: "sqlite" } })).toBe(
      "sqlite",
    );
  });

  it("registers PostgreSQL support only for Workboard", () => {
    expect(
      listDatabaseEngineStores()
        .filter((store) => store.postgres)
        .map((store) => store.id),
    ).toEqual(["workboard"]);
  });
});
