import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NativeWorker } from "../infra/worker-native-handle.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import type { GenerationWorkerInput } from "./plugin-generation-worker-contract.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("scopes worker admission metadata while reusing native captures from another plugin", async () => {
  await withOpenClawTestState({ label: "worker-admission-scope" }, async (state) => {
    const fixture = createFixture(state.path("installed"), false);
    const neighbor = createFixture(state.path("installed-neighbor"), false);
    const cache = createPluginCache();
    const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
    try {
      await withArtifactPreservingStateReads(() =>
        withPluginCache(cache, () =>
          withPluginSourceCaptureStorage(
            { stateDir: state.stateDir, placement: "temporary" },
            async () => {
              preparePluginNativeAdmissions(fixture.index, cache);
              preparePluginNativeAdmissions(neighbor.index, cache);
              const shared = capturePluginGenerationArtifact(neighbor.root);
              try {
                const sharedNative = fs.realpathSync(shared.resolve(neighbor.filename));
                for (const warm of [false, true]) {
                  posts.mockClear();
                  const prepared = await preparePluginGenerationArtifact({
                    rootDir: fixture.root,
                    source: fixture.entry,
                  });
                  try {
                    const task = posts.mock.calls
                      .map(([value]) => (isRecord(value) ? value.input : undefined))
                      .find((input) => isRecord(input) && input.operation === "capture");
                    expect(task).toBeDefined();
                    // The observed task is the real capture packet, before structured cloning.
                    const { admission } = task as Extract<
                      GenerationWorkerInput,
                      { operation: "capture" }
                    >;
                    expect([...admission.owners.keys()]).toEqual([fixture.root]);
                    expect(admission.owners.get(fixture.root)).toEqual({
                      pluginId: "fixture",
                      rootDir: fixture.root,
                      source: fixture.entry,
                      setupSource: undefined,
                      installRecordHash: undefined,
                    });
                    expect([...admission.receipts.keys()]).toEqual(
                      warm ? [`${fixture.root}\0`] : [],
                    );
                    expect(nativeAdmissionStateFor().receipts.size).toBe(2);
                    expect(fs.readFileSync(prepared.artifact.resolve(fixture.filename))).toEqual(
                      fixture.bytes,
                    );
                    const captured = prepared.artifact.captureResolvedModule(neighbor.filename)!;
                    const sharedStat = fs.statSync(sharedNative, { bigint: true });
                    expect(fs.statSync(captured, { bigint: true })).toMatchObject({
                      dev: sharedStat.dev,
                      ino: sharedStat.ino,
                    });
                    expect(fs.readFileSync(captured)).toEqual(neighbor.bytes);
                  } finally {
                    await prepared.artifact.disposeAsync();
                  }
                }
              } finally {
                await shared.disposeAsync();
              }
            },
          ),
        ),
      );
    } finally {
      posts.mockRestore();
      await retirePluginCache(cache);
    }
  });
});

it("joins retained capture workers before terminal native-source shutdown", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-shutdown-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    '{"name":"shutdown-fixture","type":"module"}',
  );
  const entry = path.join(source, "index.js");
  fs.writeFileSync(entry, "export const value = 42;");
  await withArtifactPreservingStateReads(() =>
    withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
      const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
      const capturesBeforeRecovery = fs.readdirSync(path.dirname(prepared.artifact.boundaryRoot));
      const recovery = prepared.artifact.captureRecoverySource();
      const capturesWithRecovery = fs.readdirSync(path.dirname(prepared.artifact.boundaryRoot));
      const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      expect(nativeSource.hasActiveWorkers).toBe(true);
      expect(fs.readFileSync(prepared.artifact.resolve(entry), "utf8")).toContain("42");
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
  const roots = { ...resolvePluginInstallRoots(), stateDir: root };
  const cache = createPluginCache();
  let releasePublication!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    await withPluginCache(cache, () =>
      withPluginInstallRoots(roots, () =>
        withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          const preparing = withPluginSourceAdmissionPublisher(
            async () => {
              publicationStarted();
              await gate;
              return false;
            },
            () => preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
          );
          // Observe rejection while the publication gate is held, then assert the result below.
          void preparing.catch(() => {});
          await started;
          // Advance the real pool's task timer without sleeping for two minutes.
          try {
            await vi.advanceTimersByTimeAsync(120_001);
            releasePublication();
            const prepared = await preparing;
            try {
              expect(fs.readFileSync(prepared.artifact.resolve(fixture.entry), "utf8")).toContain(
                "fixture",
              );
            } finally {
              await prepared.artifact.disposeAsync();
            }
          } finally {
            vi.useRealTimers();
          }
        }),
      ),
    );
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
          withPluginSourceCaptureStorage(
            { stateDir: state.stateDir, placement: "temporary" },
            async () => {
              preparePluginNativeAdmissions(fixture.index, cache);
              const prepared = await preparePluginGenerationArtifact({
                rootDir: fixture.root,
                source: fixture.entry,
              });
              try {
                expect(fs.existsSync(state.statePath("tmp", "plugin-captures"))).toBe(false);
                const captured = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
                expect(fs.readFileSync(captured).equals(fixture.bytes)).toBe(true);
                const persisted = await readPersistedInstalledPluginIndex({
                  stateDir: roots.stateDir,
                });
                const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
                expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(captured);
                const redirected = await readPersistedInstalledPluginIndex({
                  stateDir: state.stateDir,
                });
                expect(Object.keys(redirected?.plugins[0]?.sourceAdmissions ?? {})).toHaveLength(0);
              } finally {
                await prepared.artifact.disposeAsync();
              }
            },
          ),
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
    const root = fs.realpathSync(temp.make("plugin-generation-worker-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "worker-fixture", version: "1.0.0", type: "module" }),
    );
    const entry = path.join(source, "index.js");
    fs.writeFileSync(entry, "export const value = 42;");
    await withArtifactPreservingStateReads(() =>
      withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
        const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
        prepared.attachModuleSource((filename) => filename);
        const artifact = prepared.artifact;
        let moduleFactCallbacks: WeakRef<object>[] | undefined;
        expect(fs.readFileSync(artifact.resolve(entry), "utf8")).toContain("42");
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
          const replies = Array.from(
            { length: 100 },
            () => new WeakRef(artifact.prepareModule(entry)),
          );
          const control = new WeakRef({});
          await nextTurn();
          queryObjects(WeakRef);
          expect(control.deref()).toBeUndefined();
          expect(replies.every((reply) => reply.deref() === undefined)).toBe(true);
          expect(fs.readFileSync(artifact.resolve(entry), "utf8")).toContain("42");
          const releaseRecovery = async () => {
            const recovery = artifact.captureRecoverySource();
            const references = [
              new WeakRef(recovery.fork),
              new WeakRef(recovery.sourceCapture.capture),
            ];
            await recovery.disposeAsync();
            return references;
          };
          const released = await releaseRecovery();
          await nextTurn();
          queryObjects(WeakRef);
          expect(released.every((reference) => reference.deref() === undefined)).toBe(true);
          expect(fs.readFileSync(artifact.resolve(entry), "utf8")).toContain("42");
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
        expect(fs.readFileSync(artifact.resolve(entry), "utf8")).toContain("42");
        await artifact.disposeAsync();
        await nextTurn();
        queryObjects(WeakRef);
        const moduleFactsReleased = moduleFactCallbacks?.every((callback) => !callback.deref());
        expect(fs.readFileSync(recovery.resolve(entry), "utf8")).toContain("42");
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

it("isolates an active artifact from a sibling capture waiting on host publication", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-sibling-"));
  const fixture = createFixture(path.join(root, "installed"), false);
  const cache = createPluginCache();
  const siblingCache = createPluginCache();
  const roots = { ...resolvePluginInstallRoots(), stateDir: root };
  let releasePublication!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  try {
    await withPluginCache(cache, () =>
      withPluginInstallRoots(roots, () =>
        withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          preparePluginNativeAdmissions(fixture.index, siblingCache);
          const first = await withPluginSourceAdmissionPublisher(
            async () => false,
            () => preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
          );
          const firstDirectory = path.dirname(first.artifact.boundaryRoot);
          const preparing = withPluginSourceAdmissionPublisher(
            async () => {
              publicationStarted();
              await gate;
              return false;
            },
            () =>
              withPluginCache(siblingCache, () =>
                preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
              ),
          );
          try {
            await Promise.race([
              started,
              preparing.then(() => {
                throw new Error("Sibling capture completed without entering publication");
              }),
            ]);
            // Registration may schedule a lazy import while another plugin is preparing.
            await new Promise<void>((resolve, reject) => {
              setTimeout(() => {
                try {
                  expect(fs.readFileSync(first.artifact.resolve(fixture.entry), "utf8")).toContain(
                    "fixture",
                  );
                  resolve();
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              }, 0);
            });
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
            expect(fs.readFileSync(recovery.resolve(fixture.entry), "utf8")).toContain("fixture");
            await recovery.disposeAsync();
            // Native custody keeps each worker alive until its admission owner retires.
            await retirePluginCache(cache);
            await retirePluginCache(siblingCache);
            expect(fs.existsSync(firstDirectory)).toBe(false);
            expect(fs.existsSync(secondDirectory)).toBe(false);
          }
        }),
      ),
    );
  } finally {
    releasePublication();
    await retirePluginCache(cache);
    await retirePluginCache(siblingCache);
  }
});
