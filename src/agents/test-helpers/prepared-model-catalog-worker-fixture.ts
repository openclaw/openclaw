import fs from "node:fs";
import path from "node:path";
import { threadId, type Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import { isPreparedModelCatalogFull } from "../prepared-model-runtime.full-catalog.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.types.js";

const waitTimeoutMs = 30_000;

export function usePreparedCatalogWorkerFixtures() {
  const retirements = new Set<() => void | Promise<void>>();
  const workers = new Set<Worker>();
  let restoreWorkerFactory: (() => void) | undefined;
  async function waitForWorkers(options?: { requireCreated?: boolean }): Promise<void> {
    if (options?.requireCreated) {
      expect(workers.size, "the catalog worker creation owner was observed").toBeGreaterThan(0);
    }
    // Retirement removes exit listeners; Node's threadId still records actual termination.
    await expect
      .poll(() => [...workers].map((worker) => worker.threadId).filter((id) => id !== -1), {
        timeout: waitTimeoutMs,
      })
      .toEqual([]);
  }
  beforeEach(() => {
    const createWorker = workerCpu.createCpuTrackedWorker;
    const catalogWorkerUrl = resolveRuntimeWorkerUrl(
      runtimeProcessEntrypoints.preparedModelCatalog,
    ).href;
    const tracking = vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
      const worker = createWorker(...args);
      // Compiler services also use Worker threads; this fixture owns only catalog computation.
      if (String(args[0]) === catalogWorkerUrl) {
        workers.add(worker);
      }
      return worker;
    });
    restoreWorkerFactory = () => tracking.mockRestore();
  });
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      // Direct snapshots bypass registered owners. Fence them even when worker warmup times out,
      // before late continuations can use a removed fixture or enter the next test's catalog queue.
      for (const retire of retirements) {
        await retire();
      }
      retirements.clear();
      await resetPreparedModelRuntimeSnapshotsForTest();
      try {
        await waitForWorkers();
      } finally {
        // Keep a failed retirement assertion, but never leave its threads in the next test.
        await Promise.all([...workers].map((worker) => worker.terminate()));
        restoreWorkerFactory?.();
        restoreWorkerFactory = undefined;
        workers.clear();
        clearRuntimeAuthProfileStoreSnapshots();
        closeOpenClawAgentDatabasesForTest();
        cleanup();
      }
    });
  });
  return {
    makeTempDir: (prefix: string) => tempDirs.make(prefix),
    retireAfterTest: (retire: () => void | Promise<void>) => {
      retirements.add(retire);
    },
    waitForWorkers,
    waitForMarker: async (marker: string): Promise<void> => {
      await expect.poll(() => fs.existsSync(marker), { timeout: waitTimeoutMs }).toBe(true);
    },
  };
}

export function writeSyntheticAuthDiscoveryFixture(params: {
  root: string;
  pluginDir: string;
  harnessId: string;
  unrelatedId: string;
  pluginVersion: string;
  asyncSyntheticAuth?: boolean;
  syntheticAuthAvailable?: boolean;
}): void {
  const probePath = path.join(params.root, "synthetic-auth-probes.txt");
  fs.writeFileSync(
    path.join(params.pluginDir, "provider-discovery.cjs"),
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(params.root, "discovery-artifact-paths.jsonl"))}, JSON.stringify({ threadId: require("node:worker_threads").threadId, filename: __filename }) + "\\n");
fs.appendFileSync(${JSON.stringify(path.join(params.root, "discovery-artifacts.txt"))}, ${JSON.stringify(params.pluginVersion)} + "\\n");
module.exports = {
  id: ${JSON.stringify(params.harnessId)},
  hookAliases: [${JSON.stringify(params.unrelatedId)}],
  label: "Worker catalog fixture synthetic auth",
  auth: [],
  ${params.asyncSyntheticAuth ? "async prepareSyntheticAuth" : "resolveSyntheticAuth"}({ provider, signal }) {
    ${
      params.asyncSyntheticAuth
        ? `
    if (require("node:worker_threads").threadId !== ${threadId}) throw Error("native auth probe entered worker");
    fs.appendFileSync(${JSON.stringify(path.join(params.root, "synthetic-auth-owner.txt"))}, "parent\\n");
    if (fs.existsSync(${JSON.stringify(path.join(params.root, "synthetic-auth-hold"))})) {
      if (!signal) throw Error("held auth probe has no cancellation owner");
      await new Promise((resolve, reject) => {
        const abort = () => {
          fs.appendFileSync(${JSON.stringify(path.join(params.root, "synthetic-auth-cancel.txt"))}, "abort\\n");
          const cleanup = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(path.join(params.root, "synthetic-auth-hold"))})) return;
            clearInterval(cleanup);
            fs.appendFileSync(${JSON.stringify(path.join(params.root, "synthetic-auth-cancel.txt"))}, "joined\\n");
            reject(signal.reason);
          }, 5);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    `
        : ""
    }
    fs.appendFileSync(${JSON.stringify(probePath)}, provider + "\\n");
    return ${params.syntheticAuthAvailable !== false} && provider === ${JSON.stringify(params.harnessId)}
      ? { apiKey: "native-login-not-real", source: "fixture native login", mode: "oauth" }
      : undefined;
  },
};
`,
    "utf8",
  );
}

export function markPluginMetadataSnapshotProvided(
  snapshot: PluginMetadataSnapshot,
): PluginMetadataSnapshot {
  return { ...snapshot, registrySource: "provided", registryDiagnostics: [] };
}

export function readCatalogDiscoveryCaptures(root: string) {
  return fs
    .readFileSync(path.join(root, "discovery-artifact-paths.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { threadId: number; filename: string });
}

export async function refreshNativeCatalogDuringBoundedRead(params: {
  snapshot: PreparedModelRuntimeSnapshot;
  inventoryOwner: Pick<PreparedModelRuntimeOwner, "catalogInventory">;
  harnessId: string;
}): Promise<ModelCatalogSnapshot> {
  const { snapshot, inventoryOwner } = params;
  const previous = await snapshot.loadFullModelCatalog!({ refresh: true });
  const previousInventory = inventoryOwner.catalogInventory;
  const previousModels = snapshot.readPublishedModels?.();
  const nativeHarness = snapshot.pluginRegistry?.agentHarnesses.find(
    ({ harness }) => harness.id === params.harnessId,
  )?.harness;
  if (!nativeHarness?.loadModelCatalog) {
    throw new Error("expected native catalog fixture harness");
  }
  const started = createDeferredCore();
  const release = createDeferredCore();
  const loadNative = nativeHarness.loadModelCatalog.bind(nativeHarness);
  nativeHarness.loadModelCatalog = async (context) => {
    started.resolve();
    await release.promise;
    return loadNative(context);
  };
  const refresh = snapshot.loadFullModelCatalog!({ refresh: true });
  try {
    await started.promise;
    // A bounded read must keep one published generation while its native source is held.
    expect(await snapshot.loadFullModelCatalog!()).toBe(previous);
    expect(snapshot.readFullModelCatalog!()).toBe(previous);
    expect(snapshot.readPublishedModels?.()).toBe(previousModels);
    expect(inventoryOwner.catalogInventory).toBe(previousInventory);
  } finally {
    release.resolve();
    try {
      await refresh;
    } finally {
      nativeHarness.loadModelCatalog = loadNative;
    }
  }
  const completed = await refresh;
  expect(completed).not.toBe(previous);
  return completed;
}

/** Full-result assertions follow publication after the bounded foreground read returns. */
export async function loadCompletedFullCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  options?: { refresh?: boolean },
): Promise<ModelCatalogSnapshot> {
  const previous = snapshot.readFullModelCatalog!();
  await snapshot.loadFullModelCatalog!(options);
  let completed: ModelCatalogSnapshot | undefined;
  await expect
    .poll(
      () => {
        const catalog = snapshot.readFullModelCatalog!();
        if (
          catalog &&
          isPreparedModelCatalogFull(catalog) &&
          !catalog.pendingProviders?.length &&
          !catalog.refreshFailed &&
          (!options?.refresh || catalog !== previous)
        ) {
          completed = catalog;
          return true;
        }
        return false;
      },
      { timeout: waitTimeoutMs },
    )
    .toBe(true);
  return completed!;
}
