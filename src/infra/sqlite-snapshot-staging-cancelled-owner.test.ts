import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { mapRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as spawnBroker from "../process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import {
  cleanupSnapshotOperations,
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanupSnapshotOperations();
    cleanup();
  }),
);

it("joins a prepared broker after cancellation before any snapshot task", async () => {
  const root = tempDirs.make("snapshot-cancelled-bootstrap-");
  const creation = vi.spyOn(spawnBroker, "createSpawnBrokerHost");
  const controller = new AbortController();
  const cancellation = new Error("snapshot cancelled before admission");
  let owner: ReturnType<typeof captureSqliteSnapshotStagingOwner> | undefined;
  let brokerPid: number | undefined;
  let generationReleased = false;
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        const retained = new URL(url);
        retained.searchParams.set("snapshot-test-generation", "cancelled-bootstrap");
        return retained;
      });
      owner = captureSqliteSnapshotStagingOwner();
      const source = captureRetainedNativeWorkerSource();
      owner.prepareResources();
      const constructed = creation.mock.results.at(-1);
      if (constructed?.type !== "return" || !constructed.value.pid) {
        throw new Error("Snapshot preparation did not start its native broker");
      }
      brokerPid = constructed.value.pid;
      expect(isPidDefinitelyDead(brokerPid)).toBe(false);
      expect(source.hasActiveWorkers).toBe(false);
      controller.abort(cancellation);
      expect(() =>
        startSqliteReadOnlyLocationAsync(
          path.join(root, "never-opened.sqlite"),
          { signal: controller.signal },
          owner,
        ),
      ).toThrow(cancellation);
      expect(source.hasActiveWorkers).toBe(false);
    },
    async () => {
      generationReleased = true;
    },
  );
  expect(generationReleased).toBe(true);
  expect(brokerPid).toBeDefined();
  expect(isPidDefinitelyDead(brokerPid!)).toBe(true);
  expect(() =>
    startSqliteReadOnlyLocationAsync(path.join(root, "never-opened.sqlite"), {}, owner),
  ).toThrow("SQLite snapshot staging owner is closing");
});

it.each([true, false])(
  "preserves unpublished allocation cleanup or caller cancellation (retirementFails=%s)",
  async (retirementFails) => {
    const root = tempDirs.make("snapshot-cancelled-owner-");
    const source = path.join(root, "source.sqlite");
    const database = new (requireNodeSqlite().DatabaseSync)(source);
    try {
      database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
    } finally {
      database.close();
    }
    const original = fs.readFileSync(source);
    vi.stubEnv("XDG_CACHE_HOME", root);
    const controller = new AbortController();
    const cancellation = new Error("caller retired");
    const owner = captureSqliteSnapshotStagingOwner();
    const start = owner.start;
    let directory: string | undefined;
    let releaseReader: (() => void) | undefined;
    vi.spyOn(owner, "start").mockImplementation((...args) => {
      const originalRequest = start(...args);
      const mapped = mapRetainedOperation(originalRequest, (reply) => {
        if (reply.type !== "prepared") {
          throw new Error("Expected a real prepared snapshot before cancellation");
        }
        directory = reply.directory;
        if (retirementFails) {
          releaseReader = retainSnapshotTempDirectory(directory);
        }
        controller.abort(cancellation);
        return reply;
      });
      return { ...mapped, startClose: () => originalRequest.startClose() };
    });
    const preparation = startSqliteReadOnlyLocationAsync(source, {
      preserveSourceArtifacts: true,
      signal: controller.signal,
    });
    try {
      const error = await preparation.result.catch((value: unknown) => value);
      expect(directory).toBeDefined();
      if (retirementFails) {
        expect(error).toBeInstanceOf(SqliteSnapshotCleanupError);
        expect(error).toMatchObject({
          message: expect.stringContaining("snapshot cleanup failed"),
        });
        const cleanupError = await preparation.startClose().result.catch((value: unknown) => value);
        expect(
          collectNestedErrorCandidates(cleanupError).some(
            (candidate) => candidate instanceof SqliteSnapshotCleanupError,
          ),
        ).toBe(true);
        expect(fs.existsSync(directory!)).toBe(true);
      } else {
        expect(error).toBe(cancellation);
        await expect(preparation.startClose().result).resolves.toBeUndefined();
        expect(fs.existsSync(directory!)).toBe(false);
      }
    } finally {
      releaseReader?.();
      await preparation.startClose().result;
      if (directory) {
        expect(fs.existsSync(directory)).toBe(false);
      }
    }
    expect(fs.readFileSync(source)).toEqual(original);
  },
);
