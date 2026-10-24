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

it.each([
  ...(["success", "failure", "cancel"] as const).map((outcome) => ({
    source: "direct",
    outcome,
    owner: "caller" as const,
  })),
  { source: "snapshot", outcome: "close-failure", owner: "caller" },
  ...(["startup", "scope"] as const).map((owner) => ({
    source: "snapshot",
    outcome: "cancel" as const,
    owner,
  })),
])(
  "joins all $source children and closes their readers before $outcome settlement (owner=$owner)",
  async ({ source, outcome, owner }) => {
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
    const preload = marker("pause-reader-close.cjs");
    const sources = paths.map((pathname) =>
      path.toNamespacedPath(fs.realpathSync.native(pathname)),
    );
    const originalBytes = paths.map((pathname) => fs.readFileSync(pathname));
    const locations: string[] = [];
    const cleanedSnapshots = new Set<number>();
    const firstSnapshotCleaned = createDeferred();
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
    const prepare = vi
      .spyOn(snapshots, "prepareSqliteReadOnlyLocation")
      .mockImplementation(async (pathname, options) => {
        const prepared = await prepareLocation(pathname, options);
        if (pathname === statePath) {
          return prepared;
        }
        const index = sources.indexOf(path.toNamespacedPath(pathname));
        expect(index).toBeGreaterThanOrEqual(0);
        locations[index] = path.toNamespacedPath(fs.realpathSync.native(prepared.location));
        publishReadPaths(locations);
        return {
          ...prepared,
          cleanupAsync: async () => {
            const removed = await prepared.cleanupAsync();
            cleanedSnapshots.add(index);
            if (index === 0) {
              firstSnapshotCleaned.resolve();
            }
            return removed;
          },
        };
      });
    vi.mocked(fork).mockClear();
    const controller = new AbortController();
    const cancellation = new Error("intentional reader cancellation");
    const onAgentInspection = vi.fn();
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
        onAgentInspection,
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
    let childClosures: Promise<void>[] = [];
    try {
      await vi.waitFor(
        () => {
          expectFiles([marker("close-0"), marker("close-1")], true);
        },
        { timeout: 10_000 },
      );
      expect(settled()).toBe(false);
      expect(
        prepare.mock.calls.filter(([pathname]) =>
          sources.includes(path.toNamespacedPath(pathname)),
        ),
      ).toHaveLength(source === "snapshot" ? 2 : 0);
      expect(cleanedSnapshots.size).toBe(0);
      // Snapshot-copy workers use spawn; this counts the two schema-reader children.
      expect(fork).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(marker("close-2"))).toBe(false);
      const readLocations = source === "snapshot" ? locations : sources;
      const [firstReadLocation, secondReadLocation] = readLocations;
      if (firstReadLocation === undefined || secondReadLocation === undefined) {
        throw new Error("Both paused readers must have a prepared database path");
      }
      expectFiles(readLocations.slice(0, 2), true);

      const children = vi
        .mocked(fork)
        .mock.results.filter((result) => result.type === "return")
        .map(({ value }) => value);
      let closedChildren = 0;
      childClosures = children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => {
              closedChildren += 1;
              resolve();
            });
          }),
      );
      if (outcome === "cancel") {
        controller.abort(cancellation);
        await setImmediate();
        expect(children.map((child) => child.killed)).toEqual([true, true]);
        await expect(run).rejects.toBe(cancellation);
      } else {
        fs.writeFileSync(marker("release-0"), "resume");
        if (outcome === "close-failure") {
          await vi.waitFor(() => expect(fs.existsSync(marker("retired-0"))).toBe(true), {
            timeout: 10_000,
          });
          expect(settled()).toBe(false);
          expect(closedChildren).toBe(0);
          expect(cleanedSnapshots.size).toBe(0);
          expect(fs.existsSync(firstReadLocation)).toBe(true);
          fs.writeFileSync(marker("exit-release"), "resume");
        }
        if (outcome === "failure" || outcome === "close-failure") {
          await childClosures[0];
          if (source === "snapshot") {
            await withTestTimeout(
              firstSnapshotCleaned.promise,
              10_000,
              "failed-close child snapshot did not clean up after exit",
            );
          }
          // Drain the first child's result before checking the still-owned peer.
          await setImmediate();
          expect(settled()).toBe(false);
          if (source === "snapshot") {
            expect(cleanedSnapshots).toEqual(new Set([0]));
            expect(fs.existsSync(secondReadLocation)).toBe(true);
          }
          expect(fork).toHaveBeenCalledTimes(2);
        }
        fs.writeFileSync(marker("release-1"), "resume");
        if (outcome === "failure") {
          await expect(run).rejects.toMatchObject({ name: "SqliteIntegrityError" });
        } else if (outcome === "close-failure") {
          await expect(run).rejects.toThrow("native snapshot close failure");
        } else {
          await expect(run).resolves.toEqual(compatible);
        }
      }
      expect(closedChildren).toBe(2);
      expect(fork).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(marker("close-2"))).toBe(outcome === "success");
      if (outcome === "success") {
        expect(onAgentInspection).toHaveBeenCalledExactlyOnceWith({
          schemaProcessCount: 2,
          schemaInspectionCount: 3,
          schemaSnapshotCount: 0,
        });
      }
      expectFiles(
        locations.map((location) => path.dirname(location)),
        false,
      );
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
      fs.writeFileSync(marker("release-0"), "resume");
      fs.writeFileSync(marker("release-1"), "resume");
      fs.writeFileSync(marker("exit-release"), "resume");
      controller.abort(cancellation);
      await Promise.allSettled([run, ...childClosures]);
    }
  },
);

function createSnapshotCandidates() {
  const { inspect } = createPreflightState(tempDirs.make("openclaw-preflight-lifecycle-state-"));
  const directory = tempDirs.make("openclaw-preflight-lifecycle-agents-");
  const paths = [0, 1, 2].map((index) => path.join(directory, `agent-${index}.sqlite`));

  // Closed WAL families retain the private snapshot recovery path.
  for (const pathname of paths) {
    execSql(
      pathname,
      `PRAGMA journal_mode=WAL; PRAGMA user_version = ${supportedVersions.agent + 1};`,
    );
    expectFiles([`${pathname}-wal`, `${pathname}-shm`], false);
  }

  return { inspect, paths };
}

it.each(["cancel", "failure"] as const)(
  "drains started snapshots before propagating %s",
  async (outcome) => {
    const fixture = createSnapshotCandidates();
    const cancel = outcome === "cancel";
    const secondPrepared = createDeferred();
    const cleanupStarted = createDeferred();
    const firstCleaned = createDeferred();
    const release = createDeferred();
    const cleaned: string[] = [];
    let active = 0,
      peak = 0,
      cleanupCount = 0;
    let peerCleanupFinished = false;
    const sourcePaths = new Set(fixture.paths.map((pathname) => fs.realpathSync.native(pathname)));
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    const preparedPaths: string[] = [],
      locations: string[] = [];
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        const prepared = await prepare(pathname, options);
        if (!sourcePaths.has(pathname)) {
          return prepared;
        }
        const ordinal = preparedPaths.length;
        preparedPaths.push(pathname);
        locations.push(prepared.location);
        active += 1;
        peak = Math.max(peak, active);
        if (!cancel && ordinal === 0) {
          await secondPrepared.promise;
        }
        if (ordinal === 1) {
          secondPrepared.resolve();
        }
        return {
          ...prepared,
          ...(!cancel && ordinal === 0
            ? { location: path.join(path.dirname(prepared.location), "missing.sqlite") }
            : {}),
          cleanupAsync: async () => {
            cleanupCount += 1;
            if (cancel ? cleanupCount === 2 : ordinal === 1) {
              cleanupStarted.resolve();
            }
            if (cancel || ordinal === 1) {
              await release.promise;
            }
            const removed = await prepared.cleanupAsync();
            active -= 1;
            cleaned.push(pathname);
            if (ordinal === 0) {
              firstCleaned.resolve();
            }
            if (ordinal === 1) {
              peerCleanupFinished = true;
            }
            return removed;
          },
        };
      },
    );
    const controller = new AbortController();
    const run = fixture.inspect({
      supportedVersions,
      requireStartupMigrationReadiness: true,
      configuredAgentDatabaseCandidatePaths: fixture.paths,
      signal: cancel ? controller.signal : undefined,
    });
    const settled = trackSettlement(run);
    let settledBeforeRelease = true,
      preparedBeforeRelease = -1;
    try {
      await withTestTimeout(cleanupStarted.promise, 10_000, "snapshot cleanup did not start");
      if (cancel) {
        expect({ active, peak, paths: preparedPaths.length, locations: locations.length }).toEqual({
          active: 2,
          peak: 2,
          paths: 2,
          locations: 2,
        });
        expectFiles(
          locations.map((location) => path.dirname(location)),
          true,
        );
        controller.abort(new Error("intentional preflight cancellation"));
      } else {
        await withTestTimeout(firstCleaned.promise, 10_000, "failing snapshot did not clean up");
      }
      await Promise.resolve();
      settledBeforeRelease = settled();
      preparedBeforeRelease = preparedPaths.length;
    } finally {
      secondPrepared.resolve();
      release.resolve();
      if (cancel) {
        controller.abort(new Error("intentional preflight cancellation"));
      }
      await Promise.allSettled([run]);
    }
    if (cancel) {
      await expect(run).rejects.toThrow("intentional preflight cancellation");
    } else {
      await expect(run).rejects.toThrow();
    }
    expect({
      settledBeforeRelease,
      preparedBeforeRelease,
      prepared: preparedPaths.length,
      cleaned: cleaned.length,
      active,
      peak,
      peerCleanupFinished,
      locations: locations.length,
    }).toEqual({
      settledBeforeRelease: false,
      preparedBeforeRelease: 2,
      prepared: 2,
      cleaned: 2,
      active: 0,
      peak: 2,
      peerCleanupFinished: true,
      locations: 2,
    });
    expectFiles(
      locations.map((location) => path.dirname(location)),
      false,
    );
  },
);
