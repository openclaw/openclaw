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
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { readSqliteTextEncoding, schemaAdmission } from "./sqlite-schema-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";

describe("connection-local SQLite physical cache facts", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

  it("retries first publication after capture and acknowledgement failures", () => {
    const filename = path.join(tempDirs.make("sqlite-first-publication-"), "state.sqlite");
    const database = openDatabase(undefined, false, filename);
    const captureFailure = new Error("Header validation refused");
    const acknowledgementFailure = new Error("Publication was not acknowledged");
    const exchange = vi.fn((_admissions: ReturnType<typeof captureSqliteDatabaseAdmissions>) => []);
    withSqliteDatabaseAdmissionExchange(exchange, () => {
      expect(() =>
        admitSqliteSchema(database, () => {
          throw captureFailure;
        }),
      ).toThrow(captureFailure);
      expect(exchange).not.toHaveBeenCalled();
      exchange.mockImplementationOnce(() => {
        throw acknowledgementFailure;
      });
      expect(() => admitSqliteSchema(database)).toThrow(acknowledgementFailure);
      expect(exchange).toHaveBeenCalledTimes(1);
      admitSqliteSchema(database);
      expect(exchange).toHaveBeenCalledTimes(2);
      const [published] = exchange.mock.calls[1]![0];
      expect(published!.facts.has(schemaAdmission.name)).toBe(true);
      expect(published!.facts.get("sqlite-text-encoding")?.value).toBe("UTF-8");
      admitSqliteSchema(database);
      expect(exchange).toHaveBeenCalledTimes(2);
    });
  });

  it("shares deferred facts when a new handle first becomes ready", () => {
    const filename = path.join(tempDirs.make("sqlite-deferred-adoption-"), "state.sqlite");
    const writer = openDatabase(undefined, true, filename);
    const exchange = vi.fn((_admissions: ReturnType<typeof captureSqliteDatabaseAdmissions>) => []);
    withSqliteDatabaseAdmissionExchange(exchange, () => {
      writer.exec("CREATE TABLE committed_sibling(id)");
      const facts = getAdmittedSqliteSchemaFacts(writer)!;
      admitSqliteSchema(writer);
      expect(exchange).not.toHaveBeenCalled();
      const reader = openDatabase("", false, filename);
      expect(getAdmittedSqliteSchemaFacts(reader)?.admissionId).toBe(facts.admissionId);
      admitSqliteSchema(reader);
      expect(exchange).toHaveBeenCalledTimes(1);
      const [published] = exchange.mock.calls[0]![0];
      expect(published!.facts.get(schemaAdmission.name)?.value).toEqual(facts);
      admitSqliteSchema(reader);
      const alreadyShared = openDatabase("", false, filename);
      admitSqliteSchema(alreadyShared);
      expect(exchange).toHaveBeenCalledTimes(1);
    });
  });

  it("does not complete initial publication with transaction-local facts", () => {
    const filename = path.join(tempDirs.make("sqlite-scoped-readiness-"), "state.sqlite");
    const database = openDatabase(undefined, false, filename);
    const exchange = vi.fn((_admissions: ReturnType<typeof captureSqliteDatabaseAdmissions>) => []);
    withSqliteDatabaseAdmissionExchange(exchange, () => {
      database.exec("BEGIN; CREATE TABLE rolled_back(id)");
      admitSqliteSchema(database);
      expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("rolled_back")).toBe(true);
      expect(exchange).not.toHaveBeenCalled();
      database.exec("ROLLBACK");
      admitSqliteSchema(database);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("rolled_back")).toBe(false);
    });
  });

  it("leaves a historical pinned admission pending until its committed catalog is available", () => {
    const filename = path.join(tempDirs.make("sqlite-pinned-readiness-"), "state.sqlite");
    const writer = openDatabase(
      "PRAGMA journal_mode=WAL; CREATE TABLE original(id)",
      true,
      filename,
    );
    const reader = openDatabase("", false, filename);
    const exchange = vi.fn((_admissions: ReturnType<typeof captureSqliteDatabaseAdmissions>) => []);
    withSqliteDatabaseAdmissionExchange(exchange, () => {
      runSqliteSchemaReadSnapshotSync(reader, () => {
        reader.prepare("SELECT * FROM original").all();
        writer.exec("CREATE TABLE committed_sibling(id)");
        admitSqliteSchema(reader);
        expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("committed_sibling")).toBe(false);
        expect(exchange).not.toHaveBeenCalled();
      });
      admitSqliteSchema(reader);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("committed_sibling")).toBe(true);
      const [published] = exchange.mock.calls[0]![0];
      expect(published!.facts.get(schemaAdmission.name)?.value).toMatchObject({
        admissionId: getAdmittedSqliteSchemaFacts(reader)?.admissionId,
      });
    });
  });

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
