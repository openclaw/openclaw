import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runClawPluginBatch } from "../claws/plugin-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { PluginInstallRuntimeBatch } from "./install-runtime-batch.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import { hasPluginLifecycleLease, withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function preparationFixture() {
  const root = dirs.make("plugin-batch-prepare-");
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
  const records = { fixture: { source: "path" as const, installPath: root, version: "1" } };
  const index = createInstalledPluginIndex({ plugins: [], installRecords: records });
  writeConfigMachineState("plugins.installedIndex", { revision: 1, index }, { env });
  return { root, env, records, index };
}

function holdIndexRead() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const read = metadataWorker.readPluginMetadataStateRow;
  vi.spyOn(metadataWorker, "readPluginMetadataStateRow").mockImplementationOnce(async (...args) => {
    const row = await read(...args);
    entered.resolve();
    await resume.promise;
    return row;
  });
  return { entered, resume };
}

it.each(["runtime", "source", "record", "closed", "adopted", "loadpath", "rebound"])(
  "retains replaced source when the post-lease handoff loses %s ownership",
  async (failure) => {
    const root = dirs.make("plugin-batch-gap-");
    const source = path.join(root, "current");
    const previousSource = path.join(root, "previous");
    await fs.mkdir(source);
    await fs.mkdir(previousSource);
    await fs.writeFile(path.join(source, "index.ts"), "export const value = 1;");
    await fs.writeFile(path.join(source, "package.json"), "{}");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    await withEnvAsync(env, async () => {
      const records = { fixture: { source: "path" as const, installPath: source, version: "1" } };
      const cleanup = vi.fn(async (assertOwned: () => void) => {
        assertOwned();
        await fs.rm(previousSource, { recursive: true });
      });
      const reload = vi.fn(async () => {
        expect(hasPluginLifecycleLease()).toBe(false);
        if (failure === "runtime") {
          throw new Error("runtime reply lost");
        }
        if (failure === "source") {
          await fs.writeFile(path.join(source, "index.ts"), "export const value = 2;");
        } else if (failure === "record" || failure === "adopted") {
          await withPluginLifecycleLease({ env }, () =>
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords: records,
              nextInstallRecords:
                failure === "record"
                  ? { fixture: { ...records.fixture, version: "2" } }
                  : {
                      ...records,
                      adopter: {
                        source: "path",
                        sourcePath: previousSource,
                        installPath: previousSource,
                      },
                    },
              nextConfig: {},
              writeOptions: { afterWrite: { mode: "none", reason: "replacement fixture" } },
            }),
          );
        } else if (failure === "loadpath") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ plugins: { load: { paths: [previousSource] } } }),
          );
        } else if (failure === "rebound") {
          await fs.rename(previousSource, path.join(root, "retired-original"));
          await fs.mkdir(previousSource);
        } else if (failure === "closed") {
          batch.close();
        }
        return { operationId: "handoff", generation: 2, pluginIds: ["fixture"] };
      });
      const batch = new PluginInstallRuntimeBatch({ env }, reload);
      const deferred = batch.install();
      await withPluginLifecycleLease({ env }, async (lease) => {
        const captured = inspectPluginGenerationSources([{ pluginId: "fixture", rootDir: source }]);
        const write = await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: records,
          nextConfig: {},
          writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
        });
        deferred.record(
          {
            operation: "install",
            pluginId: "fixture",
            sourceDigests: captured.sourceDigests,
            write,
          },
          captured.assertSourceCurrent,
        );
        deferred.deferCleanup(cleanup, previousSource);
        await batch.prepare(lease);
      });
      await expect(batch.finish(() => {})).rejects.toThrow(
        failure === "runtime" ? "Runtime activation was not confirmed" : "source cleanup failed",
      );
      expect(reload).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      await expect(fs.stat(previousSource)).resolves.toBeDefined();
      expect(() => deferred.deferCleanup(cleanup, previousSource)).toThrow(
        "no longer accepts mutations",
      );
      await expect(batch.finish(() => {})).rejects.toThrow("handoff already started");
    });
  },
);

it("prepares the final persisted index off thread even after the lease cached an older row", async () => {
  const { env, records, index } = await preparationFixture();
  const current = { fixture: { ...records.fixture, version: "2" } };
  const reload = vi.fn(async () => ({
    operationId: "prepared",
    generation: 2,
    pluginIds: ["fixture"],
  }));
  const batch = new PluginInstallRuntimeBatch({ env }, reload);
  batch.retain("fixture");
  await withPluginLifecycleLease({ env }, async (lease) => {
    const options = { env, filePath: lease.databasePath };
    const cached = await readPersistedInstalledPluginIndex(options);
    writeConfigMachineState(
      "plugins.installedIndex",
      { revision: 2, index: { ...index, installRecords: current } },
      { env },
    );
    expect(await readPersistedInstalledPluginIndex(options)).toBe(cached);
    expect(cached?.installRecords).toEqual(records);
    const reads = observeMainThreadReads();
    try {
      await batch.prepare(lease);
      // Lease verification stays native; the installed-index query must run in its worker.
      for (const call of reads.calls) {
        expect(call.mock.calls.filter((args) => args.includes("plugins.installedIndex"))).toEqual(
          [],
        );
      }
    } finally {
      reads.restore();
    }
  });
  await batch.finish(() => {});
  expect(reload).toHaveBeenCalledWith([
    { pluginId: "fixture", installHash: hashStableJson(current.fixture), sourceDigests: {} },
  ]);
});

it.each(["current", "closed", "revoked"] as const)(
  "seals collection while the real index read is pending and publishes only while %s",
  async (authority) => {
    const { env, root, records } = await preparationFixture();
    const reload = vi.fn(async () => ({
      operationId: "prepared",
      generation: 2,
      pluginIds: ["fixture"],
    }));
    const batch = new PluginInstallRuntimeBatch({ env }, reload);
    const deferred = batch.install();
    const controller = new AbortController();
    const refusal = new Error("batch preparation authority revoked");
    let preparation: PromiseSettledResult<void> | undefined;
    const operation = withPluginLifecycleLease(
      { env, assertCurrent: () => controller.signal.throwIfAborted() },
      async (lease) => {
        const write = await withEnvAsync(env, () =>
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: records,
            nextInstallRecords: records,
            nextConfig: {},
            writeOptions: { afterWrite: { mode: "none", reason: "prepare fixture" } },
          }),
        );
        const commit = {
          operation: "install" as const,
          pluginId: "fixture",
          sourceDigests: {},
          write,
        };
        deferred.record(commit);
        const gate = holdIndexRead();
        const pending = Promise.resolve(batch.prepare(lease));
        const settled = Promise.allSettled([pending]);
        try {
          await Promise.race([
            gate.entered.promise,
            pending.then(() => {
              throw new Error("Preparation completed without awaiting its index read");
            }),
          ]);
          expect(() => batch.install()).toThrow("no longer accepts mutations");
          expect(() => batch.retain("late")).toThrow("no longer accepts mutations");
          expect(() => deferred.record(commit)).toThrow("no longer accepts mutations");
          expect(() => deferred.deferCleanup(async () => {}, root)).toThrow(
            "no longer accepts mutations",
          );
          await expect(batch.prepare(lease)).rejects.toThrow("no longer accepts mutations");
          await expect(batch.finish(() => {})).rejects.toThrow("not prepared");
          if (authority === "closed") {
            batch.close();
          } else if (authority === "revoked") {
            controller.abort(refusal);
          }
        } finally {
          gate.resume.resolve();
          [preparation] = await settled;
        }
      },
    );
    const completion = await Promise.allSettled([operation]);
    if (authority === "current") {
      expect(completion[0]).toMatchObject({ status: "fulfilled" });
      expect(preparation).toMatchObject({ status: "fulfilled" });
      await batch.finish(() => {});
      expect(reload).toHaveBeenCalledOnce();
    } else {
      expect(preparation).toMatchObject({
        status: "rejected",
        reason: authority === "revoked" ? refusal : expect.any(Error),
      });
      await expect(batch.finish(() => {})).rejects.toThrow("not prepared");
      expect(reload).not.toHaveBeenCalled();
      batch.close();
    }
  },
);

it("holds the original batch lease until preparation settles before calling the runtime", async () => {
  const { env } = await preparationFixture();
  const gate = holdIndexRead();
  const reload = vi.fn(async () => {
    expect(hasPluginLifecycleLease()).toBe(false);
    return { operationId: "prepared", generation: 2, pluginIds: ["fixture"] };
  });
  const operation = runClawPluginBatch(
    {
      env,
      reloadPlugins: reload,
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {
          throw new Error("unexpected exit");
        },
      },
    },
    1,
    async (batch) => {
      batch?.retain("fixture");
      return "installed";
    },
    (failure) => new Error("runtime preparation failed", { cause: failure }),
  );
  const completion = Promise.allSettled([operation]);
  try {
    await Promise.race([
      gate.entered.promise,
      operation.then(() => {
        throw new Error("Batch completed without awaiting preparation");
      }),
    ]);
    expect(reload).not.toHaveBeenCalled();
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "acquired"),
    ).rejects.toMatchObject({ outcome: { kind: "held" } });
  } finally {
    gate.resume.resolve();
    await completion;
  }
  await expect(operation).resolves.toBe("installed");
  expect(reload).toHaveBeenCalledOnce();
});
