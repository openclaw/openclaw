import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logging from "../logging/logger.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { inspectSqliteSchemaHeaderInProcess } from "./sqlite-readonly-location.js";
import {
  readUpdateCandidateStateInventoryInProcess,
  readUpdateStateSchemaVersionsInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import { createStateSnapshotInput } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["versions", "snapshot", "strict", "read-error"] as const)(
  "retains nested header cleanup custody for %s",
  async (mode) => {
    const root = fs.realpathSync(dirs.make("candidate-header-cleanup-"));
    const stateDir = path.join(root, "source");
    const stagingRoot = path.join(root, "staging");
    const source = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(stagingRoot);
    const db = openNodeSqliteDatabase(source);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=7;");
    db.close();
    // Closed WAL mode without sidecars forces private preparation even without preservation.
    expect(fs.existsSync(`${source}-wal`)).toBe(false);
    expect(fs.existsSync(`${source}-shm`)).toBe(false);
    const before = fs.readFileSync(source);
    const input = createStateSnapshotInput(root, stateDir, stagingRoot);
    const inventory = await readUpdateCandidateStateInventoryInProcess(input);
    const logger = logging.getChildLogger({ subsystem: "infra/sqlite-snapshot" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    const original = new Error("header read failed");
    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its native database receiver.
    const prepare = requireNodeSqlite().DatabaseSync.prototype.prepare;
    if (mode === "read-error") {
      vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        if (sql === "PRAGMA user_version") {
          throw original;
        }
        return prepare.call(this, sql);
      });
    }
    const remove = fs.rmSync;
    const retained = new Set<string>();
    const fault = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      const directory = String(file);
      if (
        path.dirname(directory) === stagingRoot &&
        path.basename(directory).startsWith("openclaw-sqlite-readonly-")
      ) {
        retained.add(directory);
        expect(options).toMatchObject({ maxRetries: 3, retryDelay: 20 });
        throw Object.assign(new Error("private header removal denied"), { code: "EACCES" });
      }
      return remove(file, options);
    });
    try {
      const operation =
        mode === "strict"
          ? inspectSqliteSchemaHeaderInProcess(source, stagingRoot, undefined, true)
          : mode === "snapshot"
            ? snapshotUpdateCandidateState({
                ...input,
                pluginPlanPath: path.join(stagingRoot, inventory.pluginPlan),
                databaseInventory: [...inventory.databases.keys()],
              }).then((result) => result.versions)
            : readUpdateStateSchemaVersionsInProcess({
                ...input,
                stagingRoot,
                preserveSourceArtifacts: true,
              });
      const outcome = await operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(retained.size).toBe(1);
      if (mode === "strict") {
        expect(outcome).toMatchObject({
          error: { message: expect.stringContaining("releasing its resource failed") },
        });
      } else if (mode === "read-error") {
        expect(outcome).toEqual({ error: original });
      } else {
        expect(outcome).toMatchObject({
          value: expect.arrayContaining([{ path: source, userVersion: 7 }]),
        });
      }
      for (const directory of retained) {
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ path: directory, errorCode: "EACCES" }),
          expect.stringContaining("snapshot cleanup failed"),
        );
        expect(fs.existsSync(directory)).toBe(true);
      }
      expect(fs.readFileSync(source)).toEqual(before);
    } finally {
      fault.mockRestore();
      vi.restoreAllMocks();
      await cleanupSnapshotOperations();
      for (const directory of retained) {
        expect(fs.existsSync(directory)).toBe(false);
      }
    }
  },
);
