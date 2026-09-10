import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqliteReadOnly from "../infra/sqlite-readonly-location.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import {
  isArtifactPreservingStateRead,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

function createOptions(stateDir: string) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe.each(["admission", "explicit", "async"] as const)("%s read-only state reads", (mode) => {
  const admittedRead: typeof withExistingOpenClawStateDatabaseReadOnly = (operation, options) =>
    withArtifactPreservingStateReads(() =>
      withExistingOpenClawStateDatabaseReadOnly(operation, options),
    );
  const readState =
    mode === "async"
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync
      : mode === "admission"
        ? admittedRead
        : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  it("reads a consolidated WAL database without creating source sidecars", async () => {
    await withTempDir("openclaw-state-readonly-sidecars-", async (stateDir) => {
      const options = createOptions(stateDir);
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      const writer = new DatabaseSync(options.path);
      writer.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed');",
      );
      writer.close();
      const before = fs.readFileSync(options.path);
      expect(fs.readdirSync(path.dirname(options.path))).toEqual(["openclaw.sqlite"]);

      expect(
        await readState(({ db }) => {
          expect(isArtifactPreservingStateRead()).toBe(true);
          return db.prepare("SELECT value FROM held").all();
        }, options),
      ).toEqual([{ value: "committed" }]);
      expect(fs.readdirSync(path.dirname(options.path))).toEqual(["openclaw.sqlite"]);
      expect(fs.readFileSync(options.path)).toEqual(before);
    });
  });
  it.each(["cached", "uncached"])(
    "reads committed rows without joining a %s transaction",
    async (cacheState) => {
      await withTempDir("openclaw-state-readonly-isolated-", async (stateDir) => {
        const options = createOptions(stateDir);
        const opened = openOpenClawStateDatabase(options);
        opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");
        if (cacheState === "uncached") {
          closeOpenClawStateDatabaseForTest();
        }
        const writer = cacheState === "cached" ? opened.db : new DatabaseSync(options.path);
        writer.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
        try {
          const result = await readState(({ db, path: pathname }) => {
            expect(db).not.toBe(writer);
            expect(pathname).toBe(options.path);
            return db.prepare("SELECT value FROM held").all();
          }, options);
          expect(result).toEqual([{ value: "original" }]);
          expect(writer.isTransaction).toBe(true);
          expect(writer.prepare("SELECT value FROM held").all()).toEqual([
            { value: "uncommitted" },
          ]);
        } finally {
          writer.exec("ROLLBACK");
          if (cacheState === "uncached") {
            writer.close();
          }
        }
      });
    },
  );

  it("reuses an idle writable handle without preparing a snapshot", async () => {
    await withTempDir("openclaw-state-readonly-reuse-", async (stateDir) => {
      const options = createOptions(stateDir);
      const opened = openOpenClawStateDatabase(options);
      opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");

      let called = false;
      const result = readState(({ db }) => {
        called = true;
        expect(isArtifactPreservingStateRead()).toBe(true);
        expect(db).toBe(opened.db);
        return db.prepare("SELECT value FROM held").all();
      }, options);
      expect(called).toBe(true);
      expect(isArtifactPreservingStateRead()).toBe(false);
      opened.db.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
      try {
        expect(await result).toEqual([{ value: "original" }]);
        expect(opened.db.isTransaction).toBe(true);
      } finally {
        opened.db.exec("ROLLBACK");
      }
    });
  });
});

it.each(["latch", "quarantine", "callback"] as const)(
  "cleans the async snapshot after %s rejection",
  async (failure) => {
    await withTempDir("openclaw-state-readonly-admission-", async (stateDir) => {
      const options = createOptions(stateDir);
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
      const refused = new Error("synthetic readonly verification failure");
      const prepare = sqliteReadOnly.prepareSqliteReadOnlyLocation;
      let preparedLocation: string | undefined;
      let failurePublished = false;
      vi.spyOn(sqliteReadOnly, "prepareSqliteReadOnlyLocation").mockImplementationOnce(
        async (...args) => {
          const prepared = await prepare(...args);
          preparedLocation = prepared.location;
          if (failure === "latch") {
            failurePublished = recordOpenClawStateDatabaseOpenFailure(options.path, refused);
          } else if (failure === "quarantine") {
            failurePublished = recordOpenClawDatabaseQuarantine({
              env: options.env,
              kind: "state",
              path: options.path,
              reason: "synthetic readonly quarantine",
            });
          }
          return prepared;
        },
      );
      const operation = vi.fn(() => {
        throw refused;
      });
      try {
        const result = withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
          operation,
          options,
        );
        if (failure !== "quarantine") {
          await expect(result).rejects.toBe(refused);
        } else {
          await expect(result).rejects.toThrow("synthetic readonly quarantine");
        }
        if (failure === "callback") {
          expect(operation).toHaveBeenCalledOnce();
        } else {
          expect(failurePublished).toBe(true);
          expect(operation).not.toHaveBeenCalled();
        }
        expect(preparedLocation).toBeDefined();
        expect(fs.existsSync(path.dirname(preparedLocation!))).toBe(false);
        expect(isArtifactPreservingStateRead()).toBe(false);
      } finally {
        clearOpenClawDatabaseQuarantine(options.path, { env: options.env });
      }
    });
  },
);

it("keeps missing and non-missing filesystem failures distinct for async reads", async () => {
  await withTempDir("openclaw-state-readonly-missing-", async (stateDir) => {
    const options = createOptions(stateDir);
    const operation = vi.fn();
    await expect(
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(operation, options),
    ).resolves.toBeUndefined();
    fs.writeFileSync(path.join(stateDir, "file"), "not a directory");
    await expect(
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(operation, {
        ...options,
        path: path.join(stateDir, "file", "state.sqlite"),
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(operation).not.toHaveBeenCalled();
  });
});
