import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { databaseEngineAdapters } from "./adapters.js";

vi.mock("../postgres-sync/connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../postgres-sync/connection.js")>()),
  PostgresSyncConnection: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("PostgreSQL adapter open failures", () => {
  it.each([
    ["28P01", "password authentication failed"],
    ["53300", "too many clients already"],
    [undefined, "timeout expired"],
  ])("preserves %s diagnostics without exposing credentials", (code, message) => {
    using anchor = new DatabaseSync(":memory:");
    const secret = "synthetic-database-secret";
    const connection = `postgresql://fixture:${secret}@localhost/fixture`;
    const cause = Object.assign(new Error(`${message}; ${connection}; password=${secret}`), {
      code,
    });
    vi.mocked(PostgresSyncConnection).mockImplementation(function () {
      throw cause;
    });
    let failure: unknown;
    try {
      databaseEngineAdapters.postgres.openConnection({
        anchor,
        schema: { id: "fixture", version: 1, sqlite: "" },
        input: { connection, schemaPrefix: "openclaw" },
        storeId: "fixture",
        namespace: "fixture",
        openSqlite: () => {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected an open failure");
    }
    expect(failure.cause).toBe(cause);
    expect(failure.message).toContain(message);
    if (code) {
      expect(failure.message).toContain(code);
    }
    expect(failure.message).toContain("verify database.postgres.connection");
    expect(failure.message).not.toContain(connection);
    expect(failure.message).not.toContain(secret);
  });
});
