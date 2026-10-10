import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import {
  cleanupSnapshotOperations,
  retainSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await cleanupSnapshotOperations();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});

it("keeps snapshot bytes and their creator lock after supervisor loss until original native cleanup joins", async () => {
  const root = directories.make("staging-lost-supervisor-custody-");
  const cache = path.join(root, "cache");
  const source = path.join(root, "source.sqlite");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const sqlite = requireNodeSqlite();
  const writer = new sqlite.DatabaseSync(source);
  try {
    writer.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
  } finally {
    writer.close();
  }
  const original = fs.readFileSync(source);
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging");
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        if (url.href !== stagingUrl.href) {
          return url;
        }
        const retained = new URL(url);
        retained.searchParams.set("snapshot-test-generation", "lost-supervisor-custody");
        return retained;
      });
      const { runtimeGeneration } = captureRuntimeWorkerSource(stagingUrl);
      expect(runtimeGeneration).toBeDefined();
      const recaptureSource = () => captureRetainedNativeWorkerSource({ runtimeGeneration });
      const originalSource = recaptureSource();
      // Both spies call through: observe the actual factory handle and its real supervisor Worker.
      const constructions = vi.spyOn(originalSource, "create");
      const registrations = vi.spyOn(Worker.prototype, "on");
      const captures = vi.spyOn(SpawnBrokerHost.prototype, "captureNativeResource");
      let supervisor: Worker | undefined;
      let broker: SpawnBrokerHost | undefined;
      let prepared: RetainedPreparedSqliteReadOnlyLocation;
      try {
        prepared = await startSqliteReadOnlyLocationAsync(source, {
          preserveSourceArtifacts: true,
        }).result;
        supervisor = registrations.mock.contexts.find((receiver) => receiver instanceof Worker);
        expect(captures).toHaveBeenCalledOnce();
        const capturedBroker = captures.mock.contexts[0];
        if (!(capturedBroker instanceof SpawnBrokerHost)) {
          throw new Error("Original snapshot resource broker was not observed");
        }
        broker = capturedBroker;
      } finally {
        registrations.mockRestore();
        captures.mockRestore();
      }
      const constructed = constructions.mock.results[0];
      expect(constructions).toHaveBeenCalledOnce();
      constructions.mockRestore();
      if (constructed?.type !== "return") {
        throw new Error("Original snapshot native handle was not observed");
      }
      const native = constructed.value;
      const directory = prepared.cleanupRoot ?? path.dirname(prepared.location);
      const originalJoined = createDeferredCore();
      let nativeJoined = false;
      native.once("exit", () => {
        nativeJoined = true;
        originalJoined.resolve();
      });
      let releaseReader: (() => void) | undefined;
      let next: RetainedPreparedSqliteReadOnlyLocation | undefined;
      try {
        if (!supervisor) {
          throw new Error("Snapshot supervisor Worker was not observed");
        }
        if (!(broker instanceof SpawnBrokerHost)) {
          throw new Error("Original snapshot resource broker was not observed");
        }
        await supervisor.terminate();
        await nextTurn();
        // Supervisor exit is not the broker resource's original joined native receipt.
        expect(nativeJoined).toBe(false);
        expect(recaptureSource()).toBe(originalSource);
        await expect(native.stop().result).rejects.toBeInstanceOf(Error);
        expect(fs.existsSync(prepared.location)).toBe(true);
        const assertTokenHeld = () => {
          const token = new sqlite.DatabaseSync(path.join(directory, "owner.sqlite"), {
            timeout: 0,
          });
          try {
            expect(() => token.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
          } finally {
            if (token.isTransaction) {
              token.exec("ROLLBACK");
            }
            token.close();
          }
        };
        assertTokenHeld();
        releaseReader = retainSnapshotTempDirectory(directory);
        const reader = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
        try {
          expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
        } finally {
          reader.close();
        }
        expect(await prepared.cleanupAsync()).toBe(false);
        expect(fs.existsSync(prepared.location)).toBe(true);
        assertTokenHeld();
        expect(nativeJoined).toBe(false);
        expect(recaptureSource()).toBe(originalSource);
        releaseReader();
        releaseReader = undefined;
        const removed = await prepared.cleanupAsync();
        if (removed) {
          expect(nativeJoined).toBe(true);
        } else if (!nativeJoined) {
          expect(recaptureSource()).toBe(originalSource);
        }
        // One retry follows the original child's actual resource-close/exit receipt.
        await originalJoined.promise;
        if (!removed) {
          expect(await prepared.cleanupAsync()).toBe(true);
        }
        // Child exit releases snapshot custody; source rotation also joins the original broker.
        await broker.close();
        expect(recaptureSource()).not.toBe(originalSource);
        expect(fs.existsSync(directory)).toBe(false);
        next = await startSqliteReadOnlyLocationAsync(source, { preserveSourceArtifacts: true })
          .result;
        expect(await next.cleanupAsync()).toBe(true);
        next = undefined;
        expect(fs.readFileSync(source)).toEqual(original);
      } finally {
        releaseReader?.();
        const removed = await prepared.cleanupAsync();
        if (!removed) {
          await originalJoined.promise;
          expect(await prepared.cleanupAsync()).toBe(true);
        }
        if (next) {
          expect(await next.cleanupAsync()).toBe(true);
        }
      }
    },
    async () => {},
  );
});
