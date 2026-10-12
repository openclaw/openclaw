import { describe, expect, it } from "vitest";
import { listDatabaseEngineStores, selectDatabaseEngine } from "./registry.js";

describe("database engine selection", () => {
  it("keeps unregistered stores and default configuration on SQLite", () => {
    expect(selectDatabaseEngine({}, { database: { engine: "postgres" } })).toBe("sqlite");
    expect(selectDatabaseEngine({ postgres: true }, {})).toBe("sqlite");
    expect(selectDatabaseEngine({ postgres: true }, { database: { engine: "sqlite" } })).toBe(
      "sqlite",
    );
  });

  it("selects PostgreSQL only for stores that registered support", () => {
    expect(selectDatabaseEngine({ postgres: true }, { database: { engine: "postgres" } })).toBe(
      "postgres",
    );
    expect(
      listDatabaseEngineStores()
        .filter((store) => store.postgres)
        .map((store) => store.id),
    ).toEqual(["workboard"]);
  });
});
