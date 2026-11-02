import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import {
  physicalFactsTestEntrypoint,
  type PhysicalFactsTestResult,
} from "./physical-facts-runtime.test-support.js";
import { requireNativeDatabaseFile } from "./physical-facts.js";
import { assertPostgresCatalog, readPostgresCatalog } from "./postgres-catalog.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps native housekeeping and copied-file recovery specific to SQLite", () => {
  for (const operation of ["integrity", "repair", "file-snapshot"] as const) {
    expect(() => requireNativeDatabaseFile("postgres", operation)).toThrow(
      "PostgreSQL schema with its matching anchor",
    );
    expect(() => requireNativeDatabaseFile("sqlite", operation)).not.toThrow();
  }
});

it("refuses malformed catalog transport and detects semantic constraint drift", () => {
  expect(() => readPostgresCatalog([{ table: "items", kind: "column" }])).toThrow("catalog facts");
  const fact = (value: object) => [{ table: "items", kind: "foreignKey", value }];
  const expected = fact({ onDelete: "CASCADE", deferrable: true });
  expect(() =>
    assertPostgresCatalog(fact({ onDelete: "RESTRICT", deferrable: true }), expected),
  ).toThrow("generated contract");
  expect(() =>
    assertPostgresCatalog(fact({ deferrable: true, onDelete: "CASCADE" }), expected),
  ).not.toThrow();
});
describe.skipIf(!connection)("PostgreSQL physical admission", () => {
  it("captures one real catalog snapshot and reuses it until schema invalidation", async () => {
    expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
    const namespace = `facts_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    const databasePath = path.join(tempDirs.make("pg-physical-facts-"), "anchor.sqlite");
    const { anchor, worker } = spawnConformanceWorker(
      physicalFactsTestEntrypoint,
      databasePath,
      { connection, namespace, storeId, path: databasePath },
      (db) => {
        db.exec("CREATE TABLE anchor_identity (id TEXT)");
        admitSqliteSchema(db);
      },
      { connection: connection! },
    );
    try {
      const result = await conformanceWorkerResult<PhysicalFactsTestResult>(worker, "Catalog");
      expect(result.threadId).not.toBe(0);
      expect(result).toMatchObject({
        catalogReads: [1, 1, 2, 3],
        nativeHasParents: false,
        facts: { engine: "postgres", namespace, storeId, version: 7 },
        writtenName: "written",
        reusedAdmissionId: result.facts.admissionId,
        versionError: expect.stringContaining("metadata identity or version mismatch"),
        missingError: expect.stringContaining("restore the matching PostgreSQL schema and anchor"),
      });
      const partial = (kind: string, value: object) =>
        expect.objectContaining({ kind, value: expect.objectContaining(value) });
      const exact = (table: string, kind: string, value: object) => ({ table, kind, value });
      for (const fact of [
        exact("parents", "column", {
          name: "name",
          type: "text",
          nullable: false,
          identity: false,
          position: 2,
          default: "'seed'",
        }),
        exact("children", "foreignKey", {
          columns: ["parent_id"],
          target: "parents",
          targetColumns: ["id"],
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          deferrable: true,
          deferred: true,
        }),
        partial("constraintDefinition", { definition: "CHECK ((length(name) > 0))" }),
        partial("indexDefinition", {
          name: "child_parent",
          definition: expect.stringContaining("WHERE (parent_id > 0)"),
          valid: true,
        }),
      ]) {
        expect(result.facts.catalog).toContainEqual(fact);
      }
      expect(result.renewedAdmissionId).not.toBe(result.facts.admissionId);
    } finally {
      anchor.close();
    }
  });
});
