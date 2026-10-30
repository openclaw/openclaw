import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  getSqliteDatabaseAdmission,
  getSqliteDatabaseSchemaRevision,
  publishSqliteDatabaseAdmission,
  revokeSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import { readSqliteTextEncoding, schemaAdmission } from "./sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";

describe("connection-local SQLite physical cache facts", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

  it("does not retain the default encoding before the first schema object exists", () => {
    const filename = path.join(tempDirs.make("sqlite-empty-encoding-"), "agent.sqlite");
    const database = openDatabase("", true, filename);
    const exchange = vi.fn(() => {
      throw new Error("Physical encoding must not wait for its parent");
    });
    const recapture = () => {
      revokeSqliteDatabaseAdmissions(database);
      return withSqliteDatabaseAdmissionExchange(exchange, () =>
        getAdmittedSqliteSchemaFacts(database),
      );
    };
    expect(recapture()?.textEncoding).toBe("UTF-8");
    database.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE original(id)");
    expect(recapture()?.textEncoding).toBe("UTF-16le");
    expect(readSqliteTextEncoding(database)).toBe("UTF-16le");
    expect(exchange).not.toHaveBeenCalled();
    database.close();
    expect(getAdmittedSqliteSchemaFacts(openDatabase("", true, filename))?.textEncoding).toBe(
      "UTF-16le",
    );
  });

  it("recaptures a sibling catalog without waiting, while authority publications still exchange", () => {
    const filename = path.join(tempDirs.make("sqlite-local-catalog-"), "state.sqlite");
    const writer = openDatabase(undefined, true, filename);
    const reader = openDatabase("", true, filename);
    const oldFacts = getAdmittedSqliteSchemaFacts(reader)!;
    const oldRevision = getSqliteDatabaseSchemaRevision(reader)!;
    const cursor = createSqliteDatabaseAdmissionCursor();
    captureSqliteDatabaseAdmissions(cursor, { location: filename });
    writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
    // Invalidate both delivered cache facts: the reader must inspect its own
    // physical catalog and republish, rather than borrow the writer's result.
    revokeSqliteDatabaseAdmissions(writer);
    const exchange = vi.fn(() => {
      throw new Error("Physical catalog must not wait for its parent");
    });
    const current = withSqliteDatabaseAdmissionExchange(exchange, () =>
      getAdmittedSqliteSchemaFacts(reader),
    )!;
    expect(current.userVersion).toBe(2);
    expect(current.tables.has("committed_sibling")).toBe(true);
    expect(current.textEncoding).toBe("UTF-8");
    expect(exchange).not.toHaveBeenCalled();
    const [delta] = captureSqliteDatabaseAdmissions(cursor, { location: filename });
    expect(delta!.facts.get(schemaAdmission.name)?.value).toEqual(current);
    expect(captureSqliteDatabaseAdmissions(cursor, { location: filename })).toEqual([]);
    publishSqliteDatabaseAdmission(reader, schemaAdmission, oldFacts, {
      schemaRevision: oldRevision,
    });
    expect(getSqliteDatabaseAdmission(reader, schemaAdmission)).toBe(current);

    const hostExchange = vi.fn(() => []);
    const hostKey = { name: "catalog-test-authority", writer: "host" as const };
    withSqliteDatabaseAdmissionExchange(hostExchange, () =>
      publishSqliteDatabaseAdmission(reader, hostKey, true),
    );
    expect(hostExchange).toHaveBeenCalledTimes(1);
    expect(getSqliteDatabaseAdmission(reader, hostKey)).toBe(true);
  });
});
