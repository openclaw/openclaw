import path from "node:path";
import { getEnvironmentData, setEnvironmentData, Worker } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Result = { namespace: string; admissionId: string; catalogReads: number; threadId: number };

describe.skipIf(!connection)("PostgreSQL shared-state owner", () => {
  it("bootstraps, installs lazy fragments atomically, reuses admission, reads snapshots and closes paired handles", async () => {
    const pathname = path.join(tempDirs.make("state-postgres-"), "state.sqlite");
    const run = async (mode: "bootstrap" | "restart") => {
      const anchor = openNodeSqliteDatabase(pathname);
      admitSqliteSchema(anchor);
      const url = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "openclaw-state-db.postgres.test-support",
        distWorkerPath: "state/openclaw-state-db.postgres.test-support.js",
      });
      const previous = getEnvironmentData("openclaw.test.state.connection");
      let worker: Worker;
      try {
        setEnvironmentData("openclaw.test.state.connection", connection);
        worker = new Worker(url, {
          execArgv: resolveRuntimeWorkerThreadExecArgv(url),
          workerData: {
            path: pathname,
            mode,
            admissions: captureSqliteDatabaseAdmissions(undefined, { location: pathname }),
          },
        });
      } finally {
        setEnvironmentData("openclaw.test.state.connection", previous);
      }
      try {
        return await new Promise<Result>((resolve, reject) => {
          let result: Result | { error: string } | undefined;
          worker.on("message", (message: Result | { error: string }) => {
            result = message;
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0 || !result) {
              reject(new Error(`State worker exited ${code} without a result`));
            } else if ("error" in result) {
              reject(new Error(result.error));
            } else {
              resolve(result);
            }
          });
        });
      } finally {
        await worker.terminate();
        anchor.close();
        retireSqliteDatabaseAdmissionForPath(pathname);
      }
    };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      const cold = await run("bootstrap");
      namespace = cold.namespace;
      expect(cold.threadId).not.toBe(0);
      const restart = await run("restart");
      expect(restart.namespace).toBe(cold.namespace);
      expect(restart.admissionId).not.toBe(cold.admissionId);
      await client.query(`UPDATE "${namespace}".schema_meta SET schema_version = 23`);
      await expect(run("restart")).rejects.toThrow("PostgreSQL state metadata mismatch");
      await client.query(`DROP TABLE "${namespace}".secret_store_entries`);
      await expect(run("restart")).rejects.toThrow("PostgreSQL schema drift detected");
    } finally {
      if (!namespace) {
        const anchor = openNodeSqliteDatabase(pathname);
        try {
          const present = anchor
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'openclaw_engine_anchor'")
            .get();
          const value = present
            ? anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema
            : undefined;
          if (typeof value === "string") {
            namespace = value;
          }
        } finally {
          anchor.close();
        }
      }
      if (namespace) {
        await client.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
      }
      await client.end();
    }
  });
});
