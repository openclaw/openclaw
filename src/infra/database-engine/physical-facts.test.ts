import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, threadId, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import {
  physicalFactsTestEntrypoint,
  type PhysicalFactsTestResult,
} from "./physical-facts-runtime.test-support.js";
import { physicalDatabaseCapabilities, requireNativeDatabaseFile } from "./physical-facts.js";
import { assertPostgresCatalog, readPostgresCatalog } from "./postgres-catalog.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("physical database capabilities", () => {
  it("keeps native housekeeping and copied-file recovery specific to SQLite", () => {
    expect(physicalDatabaseCapabilities.postgres).toEqual({
      nativeFile: false,
      integrity: "server-constraints",
      wal: "skip",
      checkpoint: "skip",
      vacuum: "skip",
      readSnapshot: "repeatable-read",
    });
    expect(physicalDatabaseCapabilities.sqlite.nativeFile).toBe(true);
    for (const operation of ["integrity", "repair", "file-snapshot"] as const) {
      expect(() => requireNativeDatabaseFile("postgres", operation)).toThrow(
        "PostgreSQL schema with its matching anchor",
      );
      expect(() => requireNativeDatabaseFile("sqlite", operation)).not.toThrow();
    }
  });

  it("refuses malformed catalog transport and detects semantic constraint drift", () => {
    expect(() => readPostgresCatalog([{ table: "items", kind: "column" }])).toThrow(
      "catalog facts",
    );
    const expected = [
      { table: "items", kind: "foreignKey", value: { onDelete: "CASCADE", deferrable: true } },
    ];
    expect(() =>
      assertPostgresCatalog(
        [{ table: "items", kind: "foreignKey", value: { onDelete: "RESTRICT", deferrable: true } }],
        expected,
      ),
    ).toThrow("generated contract");
    expect(() =>
      assertPostgresCatalog(
        [{ table: "items", kind: "foreignKey", value: { deferrable: true, onDelete: "CASCADE" } }],
        expected,
      ),
    ).not.toThrow();
  });
});

describe.skipIf(!connection)("PostgreSQL physical admission", () => {
  it("captures one real catalog snapshot and reuses it until schema invalidation", async () => {
    expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
    const namespace = `facts_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    const databasePath = path.join(tempDirs.make("pg-physical-facts-"), "anchor.sqlite");
    const anchor = openNodeSqliteDatabase(databasePath);
    anchor.exec("CREATE TABLE anchor_identity (id TEXT)");
    admitSqliteSchema(anchor);
    const url = resolveRuntimeWorkerUrl(physicalFactsTestEntrypoint);
    const worker = new Worker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: {
        connection,
        namespace,
        storeId,
        path: databasePath,
        admissions: captureSqliteDatabaseAdmissions(undefined, { location: databasePath }),
      },
    });
    try {
      const result = await new Promise<PhysicalFactsTestResult>((resolve, reject) => {
        let received: PhysicalFactsTestResult | { error: string } | undefined;
        worker.on("message", (value: PhysicalFactsTestResult | { error: string }) => {
          received = value;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`Catalog worker exited ${code}`));
          } else if (!received || "error" in received) {
            reject(new Error(received?.error ?? "Catalog worker returned no result"));
          } else {
            resolve(received);
          }
        });
      });
      expect(result.threadId).not.toBe(0);
      expect(result.catalogReads).toEqual([1, 1, 2, 3]);
      expect(result.nativeHasParents).toBe(false);
      expect(result.facts).toMatchObject({ engine: "postgres", namespace, storeId, version: 7 });
      expect(result.facts.catalog).toContainEqual({
        table: "parents",
        kind: "column",
        value: {
          name: "name",
          type: "text",
          nullable: false,
          identity: false,
          position: 2,
          default: "'seed'",
        },
      });
      expect(result.facts.catalog).toContainEqual({
        table: "children",
        kind: "foreignKey",
        value: {
          columns: ["parent_id"],
          target: "parents",
          targetColumns: ["id"],
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
          deferrable: true,
          deferred: true,
        },
      });
      expect(result.facts.catalog).toContainEqual(
        expect.objectContaining({
          kind: "constraintDefinition",
          value: expect.objectContaining({ definition: "CHECK ((length(name) > 0))" }),
        }),
      );
      expect(result.facts.catalog).toContainEqual(
        expect.objectContaining({
          kind: "indexDefinition",
          value: expect.objectContaining({
            name: "child_parent",
            definition: expect.stringContaining("WHERE (parent_id > 0)"),
            valid: true,
          }),
        }),
      );
      expect(result.writtenName).toBe("written");
      expect(result.reusedAdmissionId).toBe(result.facts.admissionId);
      expect(result.renewedAdmissionId).not.toBe(result.facts.admissionId);
      expect(result.versionError).toContain("metadata identity or version mismatch");
      expect(result.missingError).toContain("restore the matching PostgreSQL schema and anchor");
    } finally {
      anchor.close();
    }
  });
});
