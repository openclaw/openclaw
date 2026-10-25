import { deepStrictEqual } from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteInspection from "../infra/sqlite-readonly-worker.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  compatible,
  databaseFixture,
  supportedVersions,
  expectFiles,
  closeDatabases,
  execSql,
  trackSettlement,
} from "./database-preflight-fixtures.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, availableParallelism: () => 2 };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeDatabases();
    cleanup();
  });
});
beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-lifecycle-cache-"));
});

function createPreflightState(stateDir: string) {
  const fixture = databaseFixture(stateDir);
  // Reader lifecycle fixtures need known empty deletion history; missing history holds stores.
  const statePath = fs.realpathSync.native(fixture.state().path);
  closeOpenClawStateDatabaseForTest();
  return { ...fixture, statePath };
}

function expectSnapshotDirectories(locations: string[], exists: boolean) {
  expectFiles(
    locations.map((location) => path.dirname(location)),
    exists,
  );
}

it.each([
  ["direct", "success", "caller"],
  ["direct", "failure", "caller"],
  ["direct", "cancel", "caller"],
  ["snapshot", "open-failure", "caller"],
  ["snapshot", "close-failure", "caller"],
  ["snapshot", "cancel", "startup"],
  ["snapshot", "cancel", "scope"],
] as const)(
  "joins all %s children before %s settlement (owner=%s)",
  async (source, outcome, owner) => {
    const root = tempDirs.make("openclaw-preflight-reader-lifecycle-");
    const initialized = databaseFixture(path.join(root, "initialized"));
    const paths = ["first", "second", "queued"].map((id) => initialized.agent(id).path);
    closeDatabases();
    const { inspect: inspectDatabases, statePath } = createPreflightState(
      path.join(root, "active-state"),
    );
    for (const [index, pathname] of paths.entries()) {
      execSql(
        pathname,
        `PRAGMA journal_mode=${source === "snapshot" ? "WAL" : "DELETE"};` +
          (outcome === "failure" && index === 0
            ? "PRAGMA foreign_keys=OFF; CREATE TABLE lifecycle_parent(id INTEGER PRIMARY KEY); CREATE TABLE lifecycle_child(parent_id REFERENCES lifecycle_parent(id)); INSERT INTO lifecycle_child VALUES (42);"
            : ""),
      );
    }

    const marker = (name: string) => path.join(root, name);
    const resume = (name: string) => fs.writeFileSync(marker(name), "resume");
    const expectMarker = (name: string, exists: boolean) => expectFiles([marker(name)], exists);
    const preload = marker("pause-reader-close.cjs");
    const sources = paths.map((pathname) =>
      path.toNamespacedPath(fs.realpathSync.native(pathname)),
    );
    const originalBytes = paths.map((pathname) => fs.readFileSync(pathname));
    const locations: string[] = [];
    const firstSnapshotCleaned = createDeferred();
    const secondPrepared = createDeferred();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    let cleanupCount = 0;
    const readPaths = marker("read-paths.json");
    const publishReadPaths = (values: string[]) => {
      fs.writeFileSync(`${readPaths}.tmp`, JSON.stringify(values));
      fs.renameSync(`${readPaths}.tmp`, readPaths);
    };
    publishReadPaths(source === "direct" ? sources : locations);
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs'), path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const root = ${JSON.stringify(root)}, readPaths = ${JSON.stringify(readPaths)};
      const outcome = ${JSON.stringify(outcome)};
      const close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.close = function() {
        const location = this.location();
        const sources = JSON.parse(fs.readFileSync(readPaths, 'utf8'));
        const index = location ? sources.indexOf(path.toNamespacedPath(path.resolve(location))) : -1;
        if (index >= 0) {
          fs.writeFileSync(path.join(root, 'close-' + index), 'ready');
          if (index < 2) {
            const deadline = Date.now() + 15000;
            const pause = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(path.join(root, 'release-' + index))) {
              if (Date.now() > deadline) throw new Error('test reader close pause expired');
              Atomics.wait(pause, 0, 0, 10);
            }
          }
          if (outcome === 'close-failure' && index === 0) {
            process.once('disconnect', () => fs.writeFileSync(path.join(root, 'retired-0'), 'ready'));
            const keepAlive = setInterval(() => {
              if (fs.existsSync(path.join(root, 'exit-release'))) clearInterval(keepAlive);
            }, 10);
            throw new Error('native snapshot close failure');
          }
        }
        return close.call(this);
      };
      `,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
    const prepareLocation = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        const prepared = await prepareLocation(pathname, options);
        if (pathname === statePath) {
          return prepared;
        }
        const index = sources.indexOf(path.toNamespacedPath(pathname));
        expect(index).toBeGreaterThanOrEqual(0);
        locations[index] = path.toNamespacedPath(fs.realpathSync.native(prepared.location));
        publishReadPaths(locations);
        if (outcome === "open-failure" && index === 0) {
          await secondPrepared.promise;
        }
        if (index === 1) {
          secondPrepared.resolve();
        }
        return {
          ...prepared,
          ...(outcome === "open-failure" && index === 0
            ? { location: path.join(path.dirname(prepared.location), "missing.sqlite") }
            : {}),
          async cleanupAsync() {
            if (outcome === "cancel" || (outcome === "open-failure" && index === 1)) {
              if (++cleanupCount === (outcome === "cancel" ? 2 : 1)) {
                cleanupStarted.resolve();
              }
              await releaseCleanup.promise;
            }
            const removed = await prepared.cleanupAsync();
            if (index === 0) {
              firstSnapshotCleaned.resolve();
            }
            return removed;
          },
        };
      },
    );
    vi.mocked(fork).mockClear();
    const nativeFork = (
      await vi.importActual<typeof import("node:child_process")>("node:child_process")
    ).fork;
    const childClosures: Promise<void>[] = [];
    let closedChildren = 0;
    vi.mocked(fork).mockImplementation((...args) => {
      const child = nativeFork(...args);
      if (childClosures.length < 2) {
        childClosures.push(
          new Promise<void>((resolve) => {
            child.once("close", () => {
              closedChildren += 1;
              resolve();
            });
          }),
        );
      }
      return child;
    });
    const controller = new AbortController();
    const cancellation = new Error("intentional reader cancellation");
    if (owner === "scope") {
      vi.spyOn(sqliteInspection, "readSqliteInspectionBudget").mockReturnValue({
        timeoutMs: 10,
        size: "fixture",
      });
    }
    const inspect = () =>
      inspectDatabases({
        supportedVersions,
        configuredAgentDatabaseCandidatePaths: paths,
        verifyCurrentSchemaShape: true,
        requireStartupMigrationReadiness: true,
        signal: owner === "scope" ? undefined : controller.signal,
      });
    const run =
      owner === "startup"
        ? withAgentDatabaseStartupAdmission(inspect)
        : owner === "scope"
          ? sqliteInspection.withSqliteReadOnlyWorkerScope(inspect, {
              signal: controller.signal,
              deadlineOwnedByCaller: true,
            })
          : inspect();
    const settled = trackSettlement(run);
    try {
      await vi.waitFor(
        () =>
          expectFiles(
            (outcome === "open-failure" ? ["close-1"] : ["close-0", "close-1"]).map(marker),
            true,
          ),
        {
          timeout: 10_000,
        },
      );
      expect(settled()).toBe(false);
      expectMarker("close-2", false);
      const readLocations = source === "snapshot" ? locations : sources;
      const [firstReadLocation, secondReadLocation] = readLocations;
      if (firstReadLocation === undefined || secondReadLocation === undefined) {
        throw new Error("Both paused readers must have a prepared database path");
      }
      expectFiles(readLocations.slice(outcome === "open-failure" ? 1 : 0, 2), true);

      const children = vi
        .mocked(fork)
        .mock.results.filter((result) => result.type === "return")
        .map(({ value }) => value);
      expect(children).toHaveLength(2);
      if (outcome === "cancel") {
        controller.abort(cancellation);
        await setImmediate();
        expect(children.map((child) => child.killed)).toEqual([true, true]);
        if (source === "snapshot") {
          await withTestTimeout(cleanupStarted.promise, 10_000, "snapshot cleanup did not start");
          expect(settled()).toBe(false);
          expectSnapshotDirectories(locations, true);
          releaseCleanup.resolve();
        }
        await expect(run).rejects.toBe(cancellation);
      } else {
        resume("release-0");
        if (outcome === "close-failure") {
          await vi.waitFor(() => expectMarker("retired-0", true), {
            timeout: 10_000,
          });
          expect(settled()).toBe(false);
          expect(closedChildren).toBe(0);
          expect(fs.existsSync(firstReadLocation)).toBe(true);
          resume("exit-release");
        }
        if (outcome === "failure" || outcome === "close-failure" || outcome === "open-failure") {
          if (outcome !== "open-failure") {
            await childClosures[0];
          }
          if (source === "snapshot") {
            await withTestTimeout(
              firstSnapshotCleaned.promise,
              10_000,
              "failed-close child snapshot did not clean up after exit",
            );
            expectSnapshotDirectories([firstReadLocation], false);
          }
          // Drain the first child's result before checking the still-owned peer.
          await setImmediate();
          expect(settled()).toBe(false);
          if (source === "snapshot") {
            expect(fs.existsSync(secondReadLocation)).toBe(true);
          }
        }
        resume("release-1");
        if (outcome === "open-failure") {
          await withTestTimeout(
            cleanupStarted.promise,
            10_000,
            "peer snapshot cleanup did not start",
          );
          expect(settled()).toBe(false);
          expectSnapshotDirectories([secondReadLocation], true);
          releaseCleanup.resolve();
        }
        if (outcome === "failure") {
          await expect(run).rejects.toMatchObject({ name: "SqliteIntegrityError" });
        } else if (outcome === "close-failure") {
          await expect(run).rejects.toThrow("native snapshot close failure");
        } else if (outcome === "open-failure") {
          await expect(run).rejects.toThrow();
        } else {
          await expect(run).resolves.toEqual(compatible);
        }
      }
      expect(closedChildren).toBe(2);
      expectMarker("close-2", outcome === "success");
      expectSnapshotDirectories(locations, false);
      deepStrictEqual(
        paths.map((pathname) => fs.readFileSync(pathname)),
        originalBytes,
      );
      expectFiles(
        paths.flatMap((pathname) =>
          ["-wal", "-shm", "-journal"].map((suffix) => pathname + suffix),
        ),
        false,
      );
    } finally {
      resume("release-0");
      resume("release-1");
      resume("exit-release");
      secondPrepared.resolve();
      releaseCleanup.resolve();
      controller.abort(cancellation);
      await Promise.allSettled([run, ...childClosures]);
    }
  },
);
