import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runClawPluginBatch } from "../claws/plugin-runtime.js";
import * as configIO from "../config/io.factory.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallRuntimeDeferral,
} from "./install-runtime-batch.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import {
  hasPluginLifecycleLease,
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "./plugin-lifecycle-lease.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  createInstalledPluginIndex,
} from "./test-helpers/installed-plugin-index.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const recordsAt = (installPath: string, version = "1") => ({
  fixture: { source: "path" as const, installPath, version },
});
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const readText = (file: string) => fs.readFile(file, "utf8");
const applied = () => ({ operationId: "prepared", generation: 2, pluginIds: ["fixture"] });
const commitRecords = (
  previousInstallRecords: Record<string, PluginInstallRecord>,
  nextInstallRecords = previousInstallRecords,
) =>
  commitPluginInstallRecordsWithConfig({
    previousInstallRecords,
    nextInstallRecords,
    nextConfig: {},
    writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
  });
async function whileReadHeld<T>(
  gate: ReturnType<typeof holdIndexRead>,
  operation: Promise<T>,
  inspect: () => void | Promise<void>,
) {
  const settled = Promise.allSettled([operation]);
  try {
    await awaitGateBeforeSettlement(gate.entered.promise, operation, "Read bypassed");
    await inspect();
  } finally {
    gate.resume.resolve();
    await settled;
  }
  return (await settled)[0];
}

async function stateFixture(prefix: string) {
  const root = dirs.make(prefix);
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
  return { root, env };
}

async function sourceFixture(prefix: string, previousName: string) {
  const { root, env: stateEnv } = await stateFixture(prefix);
  const source = path.join(root, "current");
  const env = { ...stateEnv, RETIRED_PATH: source };
  const previousSource = path.join(root, previousName);
  await fs.mkdir(source);
  await fs.mkdir(previousSource);
  await fs.writeFile(path.join(source, "index.ts"), "export const value = 1;");
  await fs.writeFile(path.join(source, "package.json"), "{}");
  const prepare = async (
    cleanup: Parameters<PluginInstallRuntimeDeferral["deferCleanup"]>[0],
    reload: ConstructorParameters<typeof PluginInstallRuntimeBatch>[1] = async () => applied(),
  ) => {
    const batch = new PluginInstallRuntimeBatch({ env }, reload);
    await withPluginLifecycleLease({ env }, async (lease) => {
      const deferred = batch.install();
      const { sourceDigests } = inspectPluginGenerationSources([
        { pluginId: "fixture", rootDir: source },
      ]);
      const write = await commitRecords({}, recordsAt(source));
      deferred.record({ operation: "install", pluginId: "fixture", sourceDigests, write });
      deferred.deferCleanup(cleanup, previousSource);
      await batch.prepare(lease);
    });
    return batch;
  };
  return { root, source, previousSource, env, prepare };
}

async function preparationFixture() {
  const { root, env } = await stateFixture("plugin-batch-prepare-");
  const records = recordsAt(root);
  const index = createInstalledPluginIndex({ plugins: [], installRecords: records });
  writeConfigMachineState("plugins.installedIndex", { revision: 1, index }, { env });
  const reload = vi.fn(async () => {
    expect(hasPluginLifecycleLease()).toBe(false);
    return applied();
  });
  return { env, records, index, reload, batch: new PluginInstallRuntimeBatch({ env }, reload) };
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

function holdPolicyRead() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const create = configIO.createConfigIO;
  vi.spyOn(configIO, "createConfigIO").mockImplementationOnce((options) => {
    const io = create(options);
    return {
      ...io,
      readConfigFileSnapshotForWrite: async (...args) => {
        const snapshot = await io.readConfigFileSnapshotForWrite(...args);
        entered.resolve();
        await resume.promise;
        return snapshot;
      },
    };
  });
  return { entered, resume };
}

function withoutCleanupReads(action: () => Promise<void>): Promise<void>;
function withoutCleanupReads(action: () => void): void;
function withoutCleanupReads(action: () => void | Promise<void>) {
  const reads = observeMainThreadReads();
  const verify = () => {
    for (const call of reads.calls) {
      expect(
        call.mock.calls.filter(
          (args) =>
            args.includes("plugins.installedIndex") || args.includes("deferred-plugin-migration:%"),
        ),
      ).toEqual([]);
    }
  };
  try {
    const pending = action();
    if (pending) {
      return pending.then(verify).finally(() => reads.restore());
    }
    verify();
  } catch (error) {
    reads.restore();
    throw error;
  }
  reads.restore();
  return undefined;
}

const handoffFailures = [
  "runtime",
  "record",
  "loadpath-during-read",
  "include-during-policy-read",
  "env-during-policy-read",
  "adopted",
  "rebound",
];

it.each(handoffFailures)(
  "retains replaced source when the post-lease handoff loses %s ownership",
  async (failure) => {
    const fixture = await sourceFixture("plugin-batch-gap-", "previous");
    const { root, source, previousSource, env } = fixture;
    const policyRead = failure.endsWith("-during-policy-read");
    const retainedFile = path.join(previousSource, "retained.txt");
    await fs.writeFile(retainedFile, "Retain committed source bytes.\n");
    await withEnvAsync(env, async () => {
      const records = recordsAt(source);
      const cleanup = vi.fn(async (assertOwned: () => void) => {
        assertOwned();
        await fs.rm(previousSource, { recursive: true });
      });
      const reload = vi.fn(async () => {
        expect(hasPluginLifecycleLease()).toBe(false);
        if (failure === "runtime") {
          throw new Error("runtime reply lost");
        }
        if (failure === "record" || failure === "adopted") {
          await withPluginLifecycleLease({ env }, () =>
            commitRecords(
              records,
              failure === "record"
                ? recordsAt(source, "2")
                : {
                    ...records,
                    adopter: {
                      source: "path",
                      sourcePath: previousSource,
                      installPath: previousSource,
                    },
                  },
            ),
          );
        } else if (failure === "rebound") {
          await fs.rename(previousSource, path.join(root, "retired-original"));
          await fs.mkdir(previousSource);
          await fs.writeFile(retainedFile, "Retain committed source bytes.\n");
        }
        return applied();
      });
      const batch = await fixture.prepare(cleanup, reload);
      const includePath = path.join(root, "plugin-policy.json");
      if (failure === "include-during-policy-read") {
        await writeJson(includePath, { load: { paths: [source] } });
        await writeJson(env.OPENCLAW_CONFIG_PATH, {
          plugins: { $include: "./plugin-policy.json" },
        });
      } else if (failure === "env-during-policy-read") {
        await writeJson(env.OPENCLAW_CONFIG_PATH, {
          plugins: { load: { paths: ["${RETIRED_PATH}"] } },
        });
      }
      const configBeforePolicyRead = await readText(env.OPENCLAW_CONFIG_PATH);
      const gate =
        failure === "loadpath-during-read"
          ? holdIndexRead()
          : policyRead
            ? holdPolicyRead()
            : undefined;
      const finishing = batch.finish(() => {});
      if (gate) {
        await whileReadHeld(gate, finishing, async () => {
          expect(cleanup).not.toHaveBeenCalled();
          if (failure === "include-during-policy-read") {
            await writeJson(includePath, { load: { paths: [previousSource] } });
          } else if (failure === "env-during-policy-read") {
            env.RETIRED_PATH = previousSource;
          } else {
            await writeJson(env.OPENCLAW_CONFIG_PATH, {
              plugins: { load: { paths: [previousSource] } },
            });
          }
        });
      }
      await expect(finishing).rejects.toThrow(
        failure === "runtime" ? "Runtime activation was not confirmed" : "source cleanup failed",
      );
      if (policyRead) {
        await expect(finishing).rejects.toThrow("still referenced by config");
      }
      expect(reload).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      await expect(readText(retainedFile)).resolves.toBe("Retain committed source bytes.\n");
      if (policyRead) {
        await expect(readText(env.OPENCLAW_CONFIG_PATH)).resolves.toBe(configBeforePolicyRead);
      }
    });
  },
);

it("prepares the final persisted index off thread even after the lease cached an older row", async () => {
  const { env, records, index, reload, batch } = await preparationFixture();
  const current = recordsAt(records.fixture.installPath, "2");
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
    await withoutCleanupReads(() => batch.prepare(lease));
  });
  await batch.finish(() => {});
  expect(reload).toHaveBeenCalledWith([
    { pluginId: "fixture", installHash: hashStableJson(current.fixture), sourceDigests: {} },
  ]);
});

it("refuses publication when authority is revoked during the real index read", async () => {
  const { env, records, reload, batch } = await preparationFixture();
  const deferred = batch.install();
  const controller = new AbortController();
  const refusal = new Error("batch preparation authority revoked");
  let preparation: PromiseSettledResult<void> | undefined;
  const operation = withPluginLifecycleLease(
    { env, assertCurrent: () => controller.signal.throwIfAborted() },
    async (lease) => {
      const write = await withEnvAsync(env, () => commitRecords(records));
      deferred.record({ operation: "install", pluginId: "fixture", sourceDigests: {}, write });
      const gate = holdIndexRead();
      preparation = await whileReadHeld(gate, batch.prepare(lease), () =>
        controller.abort(refusal),
      );
    },
  );
  await Promise.allSettled([operation]);
  expect(preparation).toMatchObject({ status: "rejected", reason: refusal });
  expect(reload).not.toHaveBeenCalled();
  batch.close();
});

it("holds the original batch lease until preparation settles before calling the runtime", async () => {
  const { env, reload } = await preparationFixture();
  const gate = holdIndexRead();
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
  await whileReadHeld(gate, operation, async () => {
    expect(reload).not.toHaveBeenCalled();
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "acquired"),
    ).rejects.toMatchObject({ outcome: { kind: "held" } });
  });
  await expect(operation).resolves.toBe("installed");
  expect(reload).toHaveBeenCalledOnce();
});

it.each(["index", "deferred obligation"] as const)(
  "keeps the %s producer outside the cleanup lease until source deletion settles",
  async (producerKind) => {
    const {
      root,
      previousSource: retired,
      env,
      prepare,
    } = await sourceFixture("custody-", "retired");

    await withEnvAsync(env, async () => {
      const enteredCleanup = createDeferredCore();
      const releaseCleanup = createDeferredCore();
      const producerHeld = createDeferredCore();
      const order: string[] = [];
      const batch = await prepare(async (assertOwned) => {
        withoutCleanupReads(assertOwned);
        enteredCleanup.resolve();
        await releaseCleanup.promise;
        withoutCleanupReads(assertOwned);
        await fs.rm(retired, { recursive: true });
        order.push("deleted");
      });
      const heldPaths = [["plugins", "entries", "held-owner", "config"]];
      const pendingMigration = (pluginId: string) => ({
        pluginId,
        reason: "Plugin migration pending",
        command: "openclaw doctor --fix",
        requiresStateMigration: true as const,
      });
      await recordDeferredPluginMigrations({
        env,
        pending: [
          {
            ...pendingMigration("held-owner"),
            configPaths: heldPaths,
            validationExcludedPaths: heldPaths,
          },
        ],
      });
      const configWithHeldObligation = JSON.stringify({
        plugins: {
          entries: {
            "held-owner": {
              enabled: false,
              config: { legacyFixture: { root: path.join(root, "unrelated-legacy-data") } },
            },
          },
        },
      });
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, configWithHeldObligation);
      const index = await readPersistedInstalledPluginIndex({ env });
      if (!index) {
        throw new Error("Cleanup fixture has no installed index");
      }
      const readRows = () => ({
        index: readPersistedInstalledPluginIndexRowSync({ env })?.value_json,
        pending: readDeferredPluginMigrations({ env, artifactPreservingReadOnly: false }),
      });
      const before = readRows();
      expect(before.pending).toMatchObject([
        { pluginId: "held-owner", validationExcludedPaths: heldPaths },
      ]);
      const acquire = leaseAcquisition.acquireOpenClawStateLease;
      vi.spyOn(leaseAcquisition, "acquireOpenClawStateLease").mockImplementation((params) =>
        acquire({
          ...params,
          acquire: async (...args) => {
            const outcome = await params.acquire(...args);
            if (params.label.includes("plugin lifecycle lease") && outcome.kind === "held") {
              producerHeld.resolve();
            }
            return outcome;
          },
        }),
      );
      const finishing = batch.finish(() => {});
      let producer: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(enteredCleanup.promise, finishing, "Cleanup not entered");
        producer = runOutsidePluginLifecycleLease(async () => {
          expect(hasPluginLifecycleLease()).toBe(false);
          if (producerKind === "index") {
            await writePersistedInstalledPluginIndex(
              {
                ...index,
                diagnostics: [{ level: "warn", message: "queued index producer" }],
              },
              { env },
            );
          } else {
            await recordDeferredPluginMigrations({
              env,
              pending: [pendingMigration("queued-owner")],
            });
          }
          order.push("committed");
        });
        expect(
          await Promise.race([
            producerHeld.promise.then(() => "held"),
            producer.then(() => "committed"),
          ]),
        ).toBe("held");
        expect(readRows()).toEqual(before);
        await expect(readText(env.OPENCLAW_CONFIG_PATH)).resolves.toBe(configWithHeldObligation);
        await expect(fs.stat(retired)).resolves.toBeDefined();
        expect(order).toEqual([]);
      } finally {
        releaseCleanup.resolve();
        await Promise.allSettled([finishing, ...(producer ? [producer] : [])]);
      }
      await expect(finishing).resolves.toMatchObject({ generation: 2 });
      await producer;
      expect(order).toEqual(["deleted", "committed"]);
      await expect(fs.stat(retired)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readText(env.OPENCLAW_CONFIG_PATH)).resolves.toBe(configWithHeldObligation);
      if (producerKind === "index") {
        expect(readRows().index).not.toBe(before.index);
        expect(readRows().pending).toEqual(before.pending);
      } else {
        expect(readRows().index).toBe(before.index);
        expect(readRows().pending).toEqual([
          ...before.pending,
          expect.objectContaining({ pluginId: "queued-owner", requiresStateMigration: true }),
        ]);
      }
    });
  },
);
