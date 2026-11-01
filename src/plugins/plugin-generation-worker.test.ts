import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as nextTimer } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NativeWorker } from "../infra/worker-native-handle.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import type { GenerationWorkerInput } from "./plugin-generation-worker-contract.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import { isPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import type { PluginSourceAdmissionReceipt } from "./plugin-source-admission.types.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof createFixture>;
const prepare = (fixture: Fixture) =>
  preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry });
async function withPrepared<T>(
  preparing: ReturnType<typeof prepare>,
  run: (artifact: Awaited<ReturnType<typeof prepare>>["artifact"]) => T,
) {
  const { artifact } = await preparing;
  try {
    return await run(artifact);
  } finally {
    await artifact.disposeAsync();
  }
}
const workersActive = () =>
  captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }).hasActiveWorkers;
const expectBytes = (filename: string, fixture: Fixture) =>
  expect(fs.readFileSync(filename)).toEqual(fixture.bytes);
const expectSource = (
  source: { resolve(filename: string): string },
  filename: string,
  text = "fixture",
) => expect(fs.readFileSync(source.resolve(filename), "utf8")).toContain(text);
const withStorage = <T>(stateDir: string, run: () => T) =>
  withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, run);
const withInstalledCapture = <T>(
  root: string,
  cache: ReturnType<typeof createPluginCache>,
  run: () => T,
) =>
  withPluginCache(cache, () =>
    withPluginInstallRoots({ ...resolvePluginInstallRoots(), stateDir: root }, () =>
      withStorage(root, run),
    ),
  );

function sourceFixture(version?: string) {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-"));
  const source = path.join(root, "source");
  const entry = path.join(source, "index.js");
  writeTree(source, {
    "package.json": { name: "fixture", version, type: "module" },
    "index.js": "export const value = 42;",
  });
  return { root, source, entry };
}

it("transports source acquisition classification and errno after worker cleanup", async () => {
  const root = temp.make("plugin-worker-unavailable-");
  const missing = path.join(root, "missing");
  await withStorage(root, async () => {
    let failure: unknown;
    try {
      await preparePluginGenerationArtifact({
        rootDir: missing,
        source: path.join(missing, "index.cjs"),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: "Error", code: "ENOENT" });
    expect(isPluginSourceAcquisitionError(failure)).toBe(true);
    expect(workersActive()).toBe(false);
  });
});

it.each(["missing", "directory"] as const)(
  "classifies an owned %s entry preparation call after initial capture",
  async (kind) => {
    const { root, source, entry } = sourceFixture();
    writeTree(source, { "directory.cjs/index.cjs": "module.exports = {};" });
    await withStorage(root, async () => {
      const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
      let failure: unknown;
      try {
        const target = path.join(source, `${kind}.cjs`);
        prepared.artifact.prepareModule(prepared.artifact.resolve(target));
      } catch (error) {
        failure = error;
      } finally {
        await prepared.artifact.disposeAsync();
      }
      expect(failure).toBeInstanceOf(Error);
      expect(isPluginSourceAcquisitionError(failure)).toBe(true);
      expect(workersActive()).toBe(false);
    });
  },
);

it("signals posted source-mapping callbacks before their worker task can finish", async () => {
  const { root, source, entry } = sourceFixture();
  writeTree(source, {
    "index.js": "export const value = 42;",
    "dependency.js": "export const value = 7;",
  });
  await withArtifactPreservingStateReads(() =>
    withStorage(root, async () => {
      const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
      const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
      try {
        const input = posts.mock.calls
          .map(([value]) => (isRecord(value) ? value.input : undefined))
          .find((value) => isRecord(value) && value.operation === "capture");
        const command = input as Extract<GenerationWorkerInput, { operation: "capture" }>;
        const progress = expectDefined(command.progressSignal, "source callback progress signal");
        let observed = Atomics.load(progress, 0);
        let mappings = 0;
        prepared.attachModuleSource((filename) => {
          const current = Atomics.load(progress, 0);
          expect(current).not.toBe(observed);
          observed = current;
          mappings++;
          return filename;
        });
        const capturedEntry = prepared.artifact.resolve(entry);
        prepared.artifact.prepareModule(capturedEntry);
        observed = Atomics.load(progress, 0);
        const captured = prepared.artifact.captureModule(capturedEntry, "./dependency.js", [
          "node",
          "import",
        ]);
        expect(mappings).toBeGreaterThan(0);
        expect(captured && "target" in captured && fs.readFileSync(captured.target, "utf8")).toBe(
          "export const value = 7;",
        );
      } finally {
        await prepared.artifact.disposeAsync();
      }
    }),
  );
});

async function withWorkerFixture(
  label: string,
  run: (context: {
    state: OpenClawTestState;
    fixture: Fixture;
    cache: ReturnType<typeof createPluginCache>;
  }) => Promise<void>,
  readOnly = true,
) {
  await withOpenClawTestState({ label }, async (state) => {
    const fixture = createFixture(state.path("installed"), false);
    const cache = createPluginCache();
    const work = () =>
      withPluginCache(cache, () =>
        withStorage(state.stateDir, () => run({ state, fixture, cache })),
      );
    try {
      await (readOnly ? withArtifactPreservingStateReads(work) : work());
    } finally {
      await retirePluginCache(cache);
    }
  });
}

it("scopes worker admission metadata while reusing native captures from another plugin", async () => {
  await withWorkerFixture("worker-admission-scope", async ({ state, fixture, cache }) => {
    const neighbor = createFixture(state.path("installed-neighbor"), false);
    const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
    preparePluginNativeAdmissions(fixture.index, cache);
    preparePluginNativeAdmissions(neighbor.index, cache);
    const shared = capturePluginGenerationArtifact(neighbor.root);
    try {
      const sharedNative = fs.realpathSync(shared.resolve(neighbor.filename));
      for (const warm of [false, true]) {
        posts.mockClear();
        await withPrepared(prepare(fixture), async (artifact) => {
          const task = posts.mock.calls
            .map(([value]) => (isRecord(value) ? value.input : undefined))
            .find((input) => isRecord(input) && input.operation === "capture");
          expect(task).toBeDefined();
          // The observed task is the real capture packet, before structured cloning.
          const { admission } = task as Extract<GenerationWorkerInput, { operation: "capture" }>;
          expect([...admission.owners.keys()]).toEqual([fixture.root]);
          expect(admission.owners.get(fixture.root)).toEqual({
            pluginId: "fixture",
            rootDir: fixture.root,
            source: fixture.entry,
            setupSource: undefined,
            installRecordHash: undefined,
          });
          expect([...admission.receipts.keys()]).toEqual(warm ? [`${fixture.root}\0`] : []);
          expect(nativeAdmissionStateFor().receipts.size).toBe(2);
          expectBytes(artifact.resolve(fixture.filename), fixture);
          const captured = artifact.captureResolvedModule(neighbor.filename)!;
          const sharedStat = fs.statSync(sharedNative, { bigint: true });
          expect(fs.statSync(captured, { bigint: true })).toMatchObject({
            dev: sharedStat.dev,
            ino: sharedStat.ino,
          });
          expectBytes(captured, neighbor);
        });
        expect(workersActive()).toBe(false);
        expect(nativeAdmissionStateFor().roots.size).toBeGreaterThan(0);
      }
    } finally {
      await shared.disposeAsync();
    }
  });
});

it("keeps a native-only recovery fork after its worker and admission cache retire", async () => {
  await withWorkerFixture("worker-native-fork", async ({ fixture, cache }) => {
    preparePluginNativeAdmissions(fixture.index, cache);
    const prepared = await prepare(fixture);
    const captured = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
    const recovery = prepared.artifact.captureRecoverySource();
    const native = recovery.native!.fork();
    try {
      await recovery.disposeAsync();
      await prepared.artifact.disposeAsync();
      expect(workersActive()).toBe(false);
      await retirePluginCache(cache);
      expectBytes(captured, fixture);
      const child = native.fork();
      await child.disposeAsync();
      expectBytes(captured, fixture);
    } finally {
      await native.disposeAsync();
      await recovery.disposeAsync();
      await prepared.artifact.disposeAsync();
    }
    expect(fs.existsSync(captured)).toBe(false);
  });
});

it("releases host preparation custody after unexpected worker exit with an outstanding artifact", async () => {
  await withWorkerFixture("worker-native-exit", async ({ fixture, cache }) => {
    const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
    try {
      preparePluginNativeAdmissions(fixture.index, cache);
      const prepared = await prepare(fixture);
      const captured = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
      const capture = posts.mock.calls.findIndex(
        ([value]) =>
          isRecord(value) && isRecord(value.input) && value.input.operation === "capture",
      );
      expect(capture).toBeGreaterThanOrEqual(0);
      const worker = posts.mock.contexts[capture] as NativeWorker;
      await worker.terminate();
      expectBytes(captured, fixture);
      await retirePluginCache(cache);
      // Pool retirement releases preparation custody asynchronously after confirmed exit.
      await vi.waitFor(() => expect(fs.existsSync(captured)).toBe(false));
    } finally {
      await closeDefaultRetainedNativeWorkerSource();
    }
  });
});

it.each(["deferred", "superseded", "terminal"] as const)(
  "hands %s lazy-capture publication to the host before retiring its worker",
  async (mode) => {
    await withWorkerFixture(
      "worker-lazy-admission",
      async ({ state, fixture, cache }) => {
        const neighbor = createFixture(state.path("dependency"), false);
        const accepted: PluginSourceAdmissionReceipt[] = [];
        let writable = false;
        await withPluginSourceAdmissionPublisher(
          async (publication) => {
            if (writable) {
              accepted.push(publication.receipt);
            }
            return writable;
          },
          async () => {
            preparePluginNativeAdmissions(fixture.index, cache);
            preparePluginNativeAdmissions(neighbor.index, cache);
            const prepared = await prepare(fixture);
            writable = mode === "superseded";
            let captured: string;
            try {
              // Synchronous lookup hands off the latest receipt without waiting on
              // its write. Terminal disposal must not strand a retry in the worker.
              captured = fs.realpathSync(
                prepared.artifact.captureResolvedModule(neighbor.filename)!,
              );
              expectBytes(captured, neighbor);
            } finally {
              if (mode === "terminal") {
                await closeDefaultRetainedNativeWorkerSource();
              }
              await prepared.artifact.disposeAsync();
            }
            expect(workersActive()).toBe(false);
            if (mode !== "superseded") {
              expect(accepted).toEqual([]);
            }
            writable = true;
            await settlePluginNativeAdmissions(cache);
            expect(accepted.at(-1)?.nativeArtifacts[neighbor.filename]).toBeDefined();
            expect(accepted.every((receipt) => receipt.nativeArtifacts[neighbor.filename])).toBe(
              true,
            );
            await retirePluginCache(cache);
            expectBytes(captured!, neighbor);
          },
        );
      },
      false,
    );
  },
);

it("joins retained capture workers before terminal native-source shutdown", async () => {
  const { root, source, entry } = sourceFixture();
  await withArtifactPreservingStateReads(() =>
    withStorage(root, async () => {
      const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
      const capturesBeforeRecovery = fs.readdirSync(path.dirname(prepared.artifact.boundaryRoot));
      const recovery = prepared.artifact.captureRecoverySource();
      const capturesWithRecovery = fs.readdirSync(path.dirname(prepared.artifact.boundaryRoot));
      const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      expect(nativeSource.hasActiveWorkers).toBe(true);
      expectSource(prepared.artifact, entry, "42");
      await closeDefaultRetainedNativeWorkerSource();
      expect(nativeSource.hasActiveWorkers).toBe(false);
      expect(fs.existsSync(prepared.artifact.boundaryRoot)).toBe(false);
      await prepared.artifact.disposeAsync();
      await recovery.disposeAsync();
      prepared.artifact.dispose();
      expect(() => prepared.artifact.prepareModule(entry)).toThrow(
        "Plugin preparation worker has closed",
      );
      expect(capturesBeforeRecovery).toEqual([path.basename(prepared.artifact.boundaryRoot)]);
      expect(capturesWithRecovery).toHaveLength(2);
    }),
  );
});

it("finishes a capture after more than two minutes without retiring its worker", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-long-capture-"));
  const fixture = createFixture(path.join(root, "installed"), false);
  const cache = createPluginCache();
  const { promise: gate, resolve: releasePublication } = createDeferredCore();
  const { promise: started, resolve: publicationStarted } = createDeferredCore();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    await withInstalledCapture(root, cache, async () => {
      preparePluginNativeAdmissions(fixture.index, cache);
      const preparing = withPluginSourceAdmissionPublisher(
        async () => {
          publicationStarted();
          await gate;
          return false;
        },
        () => prepare(fixture),
      );
      // Observe rejection while the publication gate is held, then assert the result below.
      void preparing.catch(() => {});
      await started;
      // Advance the real pool's task timer without sleeping for two minutes.
      try {
        await vi.advanceTimersByTimeAsync(120_001);
        releasePublication();
        await withPrepared(preparing, (artifact) => expectSource(artifact, fixture.entry));
      } finally {
        vi.useRealTimers();
      }
    });
  } finally {
    vi.useRealTimers();
    releasePublication();
    await retirePluginCache(cache);
  }
});

it("publishes native admission to pinned install roots while capture storage is redirected", async () => {
  await withOpenClawTestState({ label: "worker-pinned-admission" }, async (state) => {
    const fixture = createFixture(state.path("installed"), false);
    const roots = { ...resolvePluginInstallRoots(state.env), stateDir: state.path("operator") };
    const cache = createPluginCache();
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: roots.stateDir });
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    try {
      await withPluginCache(cache, () =>
        withPluginInstallRoots(roots, () =>
          withStorage(state.stateDir, async () => {
            preparePluginNativeAdmissions(fixture.index, cache);
            await withPrepared(prepare(fixture), async (artifact) => {
              expect(fs.existsSync(state.statePath("tmp", "plugin-captures"))).toBe(false);
              const captured = fs.realpathSync(artifact.resolve(fixture.filename));
              expectBytes(captured, fixture);
              const persisted = await readPersistedInstalledPluginIndex({
                stateDir: roots.stateDir,
              });
              const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
              expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(captured);
              const redirected = await readPersistedInstalledPluginIndex({
                stateDir: state.stateDir,
              });
              expect(Object.keys(redirected?.plugins[0]?.sourceAdmissions ?? {})).toHaveLength(0);
            });
          }),
        ),
      );
    } finally {
      await retirePluginCache(cache);
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...state.env, OPENCLAW_STATE_DIR: roots.stateDir }),
      );
    }
  });
});

it.each(["capture", "custody", "fork"] as const)(
  "keeps %s recovery alive beyond the short RPC deadline and owner disposal",
  async (operation) => {
    const { root, source, entry } = sourceFixture("1.0.0");
    await withArtifactPreservingStateReads(() =>
      withStorage(root, async () => {
        const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
        prepared.attachModuleSource((filename) => filename);
        const artifact = prepared.artifact;
        let moduleFactCallbacks: WeakRef<object>[] | undefined;
        expectSource(artifact, entry, "42");
        if (operation === "capture") {
          moduleFactCallbacks = (() => {
            const capturedEntry = artifact.resolve(entry);
            artifact.prepareModule(capturedEntry);
            const facts = artifact.moduleFacts(capturedEntry)!;
            expect(facts.isRequireReference("./missing.js")).toBe(false);
            return [
              new WeakRef(facts.isRequireReference),
              new WeakRef(facts.prepareDependency),
              new WeakRef(facts.capture),
            ];
          })();
        }
        // Recovery copies the captured package synchronously in the worker. Advance
        // its host deadline clock without making this lifecycle proof sleep for 30s.
        const parentRecovery = operation === "fork" ? artifact.captureRecoverySource() : undefined;
        const now = performance.now();
        const clock = vi.spyOn(performance, "now").mockReturnValue(now + 30_001);
        clock.mockReturnValueOnce(now);
        let recovery: ReturnType<typeof artifact.captureRecoverySource>;
        try {
          recovery = parentRecovery
            ? parentRecovery.fork()
            : operation === "custody"
              ? artifact.retainSourceCustody().source
              : artifact.captureRecoverySource();
        } finally {
          clock.mockRestore();
          await parentRecovery?.disposeAsync();
        }
        expectSource(artifact, entry, "42");
        await artifact.disposeAsync();
        const control = new WeakRef({});
        await nextTurn();
        queryObjects(WeakRef);
        expect(control.deref()).toBeUndefined();
        const moduleFactsReleased = moduleFactCallbacks?.every((callback) => !callback.deref());
        expectSource(recovery, entry, "42");
        const recoveredEntry = recovery.resolve(entry);
        await recovery.disposeAsync();
        // Later rollback generations compose this path mapping after its producer retires.
        expect(recovery.resolve(entry)).toBe(recoveredEntry);
        expect(() => recovery.resolve(path.join(root, "outside.js"))).toThrow(
          "Plugin recovery entry is outside its captured source package",
        );
        if (moduleFactCallbacks) {
          expect(moduleFactsReleased).toBe(true);
        }
      }),
    );
  },
);

it("shares one worker while a sibling capture waits on host publication", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-sibling-"));
  const fixture = createFixture(path.join(root, "installed"), false);
  const cache = createPluginCache();
  const siblingCache = createPluginCache();
  const { promise: gate, resolve: releasePublication } = createDeferredCore();
  const { promise: started, resolve: publicationStarted } = createDeferredCore();
  const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
  try {
    await withInstalledCapture(root, cache, async () => {
      preparePluginNativeAdmissions(fixture.index, cache);
      preparePluginNativeAdmissions(fixture.index, siblingCache);
      const first = await withPluginSourceAdmissionPublisher(
        async () => false,
        () => prepare(fixture),
      );
      const firstDirectory = path.dirname(first.artifact.boundaryRoot);
      const preparing = withPluginSourceAdmissionPublisher(
        async () => {
          publicationStarted();
          await gate;
          return false;
        },
        () => withPluginCache(siblingCache, () => prepare(fixture)),
      );
      try {
        // Resolve synchronously before the sibling's result continuation can run.
        // The shared transport must service and release its preceding capture.
        const now = performance.now();
        const clock = vi.spyOn(performance, "now").mockReturnValue(now + 30_001);
        clock.mockReturnValueOnce(now);
        try {
          first.artifact.prepareModule(first.artifact.resolve(fixture.entry));
        } finally {
          clock.mockRestore();
        }
        await Promise.race([
          started,
          preparing.then(() => {
            throw new Error("Sibling capture completed without entering publication");
          }),
        ]);
        // Registration may schedule a lazy import while another plugin is preparing.
        await nextTimer(0);
        expectSource(first.artifact, fixture.entry);
        const captureWorkers = posts.mock.calls.flatMap(([value], index) =>
          isRecord(value) && isRecord(value.input) && value.input.operation === "capture"
            ? [posts.mock.contexts[index]]
            : [],
        );
        expect(captureWorkers).toHaveLength(2);
        expect(new Set(captureWorkers).size).toBe(1);
        await expect(
          preparePluginGenerationArtifact({
            rootDir: path.join(root, "missing"),
            source: fixture.entry,
          }),
        ).rejects.toThrow();
      } finally {
        releasePublication();
        const second = await preparing;
        expect(path.dirname(second.artifact.boundaryRoot)).not.toBe(firstDirectory);
        const secondDirectory = path.dirname(second.artifact.boundaryRoot);
        const recovery = first.artifact.captureRecoverySource();
        await first.artifact.disposeAsync();
        await second.artifact.disposeAsync();
        expectSource(recovery, fixture.entry);
        await recovery.disposeAsync();
        // Admission keeps native bytes, but source workers retire with their last artifact.
        expect(fs.existsSync(firstDirectory)).toBe(false);
        expect(fs.existsSync(secondDirectory)).toBe(false);
        await retirePluginCache(cache);
        await retirePluginCache(siblingCache);
      }
    });
  } finally {
    releasePublication();
    await retirePluginCache(cache);
    await retirePluginCache(siblingCache);
  }
});
