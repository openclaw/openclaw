import { AsyncResource } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { createPluginLifecycleLeaseTestClock } from "../gateway/config-reload.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  getPluginCache,
  getProcessPluginCache,
  resetPluginCache,
  retirePluginCache,
  runOutsidePluginCache,
  waitForPluginCacheRetirement,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  hasPluginLifecycleLeaseDemand,
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
  withPluginLifecycleLeaseAsync,
  withPluginArtifactCleanupLease,
  type PluginLifecycleLeaseContext,
  type PluginMetadataLeaseContext,
} from "./plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

type LeaseChild = ChildProcessWithoutNullStreams;
type LeaseChildRun = {
  child: LeaseChild;
  ready: Promise<void>;
  completed: Promise<void>;
  phases: ReadonlySet<string>;
  waitForPhase: (phase: string) => Promise<void>;
  output: () => string;
};

const pluginModuleUrl = (name: string) => pathToFileURL(path.resolve("src/plugins", name)).href;

function expectRejected(outcome: PromiseSettledResult<unknown>, reason: unknown) {
  expect(outcome.status).toBe("rejected");
  if (outcome.status === "rejected") {
    expect(outcome.reason).toBe(reason);
  }
}

function cacheCleanup(
  cache: ReturnType<typeof getPluginCache>,
  id: string,
  cleanup: () => void | Promise<void>,
) {
  const instance = new PluginInstance(id);
  instance.lifecycle.onDispose(cleanup);
  cache.setupModules.set(id, instance);
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function withLeaseChildren<T>(fn: (children: Set<LeaseChildRun>) => Promise<T>): Promise<T> {
  const children = new Set<LeaseChildRun>();
  try {
    try {
      return await fn(children);
    } finally {
      await Promise.all(
        Array.from(children, async ({ child, completed }) => {
          await stopChildProcess(child, 5_000, { force: true });
          await completed.catch(() => {});
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${Array.from(children, (child) => child.output()).join("\n")}`, {
      cause: error,
    });
  }
}

async function runLeaseChild(
  children: Set<LeaseChildRun>,
  scriptPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<LeaseChildRun> {
  let stdout = "";
  let stderr = "";
  const phases = new Set<string>();
  const phaseWaiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const started = createDeferred<LeaseChild>();
  const completed = runCliProcessChild({
    nodeArgs: ["--import", "tsx", scriptPath, ...args],
    nodeArgsPolicy: "caller",
    env: env ?? process.env,
    onStdout(output) {
      stdout = output;
      for (const line of output.split("\n").slice(0, -1)) {
        phases.add(line);
        phaseWaiters.get(line)?.resolve();
      }
    },
    interact(child) {
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.end();
      started.resolve(child);
    },
  }).then(({ code, signal }) => {
    if (code !== 0) {
      throw new Error(`lease child ${args[0]} exited ${code ?? signal}`);
    }
  });
  void completed.catch(() => {});
  const child = await awaitGateBeforeSettlement(
    started.promise,
    completed,
    "Lease child exited before starting",
  );
  const waitForPhase = (phase: string): Promise<void> => {
    if (phases.has(phase)) {
      return Promise.resolve();
    }
    const waiter = phaseWaiters.get(phase) ?? createDeferred();
    phaseWaiters.set(phase, waiter);
    return awaitGateBeforeSettlement(
      waiter.promise,
      completed,
      `lease child ${args[0]} exited before ${phase}`,
    );
  };
  const run = {
    child,
    ready: waitForPhase("ready"),
    completed,
    phases,
    waitForPhase,
    output: () => `lease child ${args[0]} stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
  children.add(run);
  return run;
}

describe("plugin lifecycle lease", () => {
  it("keeps ownership when synchronous plugin work blocks past the lease duration", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-blocked-parent" }, async (state) => {
      await withPluginLifecycleLease({ env: state.env, leaseMs: 1_000 }, async (lease) => {
        // Finalize/repair can synchronously admit a large database while holding this lease.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
        lease.assertOwned();
        expect(lease.signal.aborted).toBe(false);
      });
      await expect(
        withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "released"),
      ).resolves.toBe("released");
    });
  });

  it.each(["native", "worker"] as const)(
    "releases retired cache facts while %s resources retain the expired lease",
    async (kind) => {
      class CacheFacts {
        readonly owner = "lifecycle-operation";
      }
      await withOpenClawTestState({ label: "plugin-lifecycle-cache-retention" }, async (state) => {
        const withLease =
          kind === "native" ? withPluginLifecycleLease : withPluginLifecycleLeaseAsync;
        const retained: Array<{ resource: AsyncResource; lease: PluginMetadataLeaseContext }> = [];
        try {
          for (let index = 0; index < 4; index++) {
            retained.push(
              await withLease({ env: state.env }, async (lease) => {
                Object.assign(getPluginCache(), { facts: new CacheFacts() });
                // A service drops caller cache scope but still inherits the lifecycle lease.
                const resource = runOutsidePluginCache(
                  () => new AsyncResource("retained-plugin-lease", { requireManualDestroy: true }),
                );
                return { resource, lease };
              }),
            );
          }
          await nextTurn();
          expect(queryObjects(CacheFacts)).toBe(0);
          for (const { resource, lease } of retained) {
            await expect(
              writePersistedInstalledPluginIndexInstallRecordsWithLease(
                { demo: { source: "npm", spec: "demo@1.0.0" } },
                { env: state.env, candidates: [], lease },
              ),
            ).rejects.toBeInstanceOf(OpenClawStateLeaseError);
            await expect(
              resource.runInAsyncScope(() => withLease({}, async () => "stale")),
            ).rejects.toBeInstanceOf(OpenClawStateLeaseError);
          }
          expect(await readPersistedInstalledPluginIndex({ env: state.env })).toBeNull();
        } finally {
          for (const { resource } of retained) {
            resource.emitDestroy();
          }
        }
      });
    },
  );

  it.for(["runtime", "cleanup"] as const)(
    "clears process demand after a %s waiter aborts or acquires and its holder releases",
    async (kind, { signal }) => {
      await withOpenClawTestState({ label: "plugin-lifecycle-demand" }, async (state) => {
        vi.useFakeTimers();
        const clock = createPluginLifecycleLeaseTestClock();
        const withWaiterLease =
          kind === "runtime" ? withPluginLifecycleLease : withPluginArtifactCleanupLease;
        const entered = createDeferred();
        const release = createDeferred();
        const cancelled = new AbortController();
        const operations: Promise<unknown>[] = [];
        try {
          expect(hasPluginLifecycleLeaseDemand()).toBe(false);
          const holder = withPluginLifecycleLease({ env: state.env, signal }, async (outer) => {
            await withPluginLifecycleLease({}, async (nested) => {
              expect(nested).toBe(outer);
              expect(nested.databasePath).toBe(
                path.resolve(state.stateDir, "state", "openclaw.sqlite"),
              );
              expect(hasPluginLifecycleLeaseDemand()).toBe(false);
            });
            entered.resolve();
            await release.promise;
          });
          operations.push(holder);
          await Promise.race([entered.promise, holder]);
          expect(hasPluginLifecycleLeaseDemand()).toBe(false);

          const aborted = withWaiterLease(
            { env: state.env, signal: cancelled.signal },
            async () => {
              throw new Error("aborted waiter acquired");
            },
          );
          operations.push(aborted);
          expect(hasPluginLifecycleLeaseDemand()).toBe(true);
          cancelled.abort(new Error("test cancellation"));
          await expect(aborted).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
          expect(hasPluginLifecycleLeaseDemand()).toBe(false);

          const acquired = vi.fn(async () => {
            expect(hasPluginLifecycleLeaseDemand()).toBe(false);
          });
          const waiter = withWaiterLease({ env: state.env, signal }, acquired);
          operations.push(waiter);
          expect(hasPluginLifecycleLeaseDemand()).toBe(true);
          release.resolve();
          await holder;
          expect(hasPluginLifecycleLeaseDemand()).toBe(false);
          await clock.waitFor(waiter);
          expect(acquired).toHaveBeenCalledOnce();
          expect(hasPluginLifecycleLeaseDemand()).toBe(false);
        } finally {
          cancelled.abort();
          release.resolve();
          await clock.waitFor(Promise.allSettled(operations));
          vi.useRealTimers();
        }
      });
    },
  );

  it("returns the operation value while recording cleanup failure", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-outcome" }, async (state) => {
      const cleanupError = new Error("cleanup failed");
      const value = {};
      let cache: ReturnType<typeof getPluginCache> | undefined;
      await expect(
        withPluginLifecycleLease({ env: state.env }, async () => {
          cache = getPluginCache();
          cacheCleanup(cache, "lease-cleanup", () => {
            throw cleanupError;
          });
          return value;
        }),
      ).resolves.toBe(value);
      expect(cache).toBeDefined();
      const cleanup = await retirePluginCache(cache!);
      expect(cleanup.failures.map((failure) => failure.error)).toEqual([cleanupError]);
      await expect(
        withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => value),
      ).resolves.toBe(value);
    });
  });

  it("joins process cleanup outcomes while preserving the original operation failure", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-cleanup-owners" }, async (state) => {
      const releaseProcess = createDeferred();
      const operationCleanupEntered = createDeferred();
      const runError = new Error("operation failed");
      const processError = new Error("process cleanup failed");
      const operationError = new Error("operation cleanup failed");
      let settled = false;
      let processCache: ReturnType<typeof getPluginCache> | undefined;
      let operationCache: ReturnType<typeof getPluginCache> | undefined;
      const operation = withPluginLifecycleLease({ env: state.env }, async () => {
        processCache = getProcessPluginCache();
        cacheCleanup(processCache, "process-cleanup", async () => {
          await releaseProcess.promise;
          throw processError;
        });
        resetPluginCache();
        operationCache = getPluginCache();
        cacheCleanup(operationCache, "operation-cleanup", () => {
          operationCleanupEntered.resolve();
          throw operationError;
        });
        throw runError;
      });
      const completion = Promise.allSettled([operation]).then(([outcome]) => {
        settled = true;
        return outcome;
      });
      try {
        await operationCleanupEntered.promise;
        await nextTurn();
        expect(settled).toBe(false);
      } finally {
        releaseProcess.resolve();
        await completion;
        await waitForPluginCacheRetirement().catch(() => {});
      }
      const outcome = await completion;
      expectRejected(outcome, runError);
      expect(processCache).toBeDefined();
      expect(operationCache).toBeDefined();
      const cleanups = await Promise.all([
        retirePluginCache(processCache!),
        retirePluginCache(operationCache!),
      ]);
      expect(
        cleanups.flatMap((cleanup) => cleanup.failures.map((failure) => failure.error)),
      ).toEqual([processError, operationError]);
      await expect(waitForPluginCacheRetirement()).resolves.toEqual({
        cleanupCount: 0,
        failures: [],
      });
    });
  });

  it("retains the lifecycle lease through cleanup after initiating authority is revoked", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-revoked-cleanup" }, async (state) => {
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      const controller = new AbortController();
      const refusal = new Error("initiating updater was revoked");
      const operation = withPluginLifecycleLease(
        { env: state.env, assertCurrent: () => controller.signal.throwIfAborted() },
        async (lease) => {
          cacheCleanup(getPluginCache(), "revoked-cleanup", async () => {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          });
          controller.abort(refusal);
          lease.assertOwned();
        },
      );
      const completion = Promise.allSettled([operation]);
      try {
        await cleanupEntered.promise;
        await expect(
          withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "acquired"),
        ).rejects.toMatchObject({ outcome: { kind: "held" } });
      } finally {
        releaseCleanup.resolve();
        await completion;
      }
      const [outcome] = await completion;
      expectRejected(outcome, refusal);
      await expect(
        withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "acquired"),
      ).resolves.toBe("acquired");
    });
  });

  it("serializes lifecycle work sharing an explicit database across state directories", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-lease" }, async (state) => {
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const events: string[] = [];
      const leaseOptions = (caller: string) => ({
        env: { ...state.env, OPENCLAW_STATE_DIR: state.path(caller) },
        path: state.path("shared-plugin-lifecycle.sqlite"),
        leaseMs: 1_000,
        waitMs: 3_000,
      });

      const first = withPluginLifecycleLease(leaseOptions("state-a"), async () => {
        events.push("first-enter");
        firstEntered.resolve();
        await releaseFirst.promise;
        events.push("first-exit");
      });
      await firstEntered.promise;
      const second = withPluginLifecycleLease(leaseOptions("state-b"), async () => {
        events.push("second-enter");
      });
      try {
        await expect(
          withPluginLifecycleLease({ ...leaseOptions("state-b"), waitMs: 0 }, async () => {}),
        ).rejects.toMatchObject({ outcome: { kind: "held" } });
        expect(events).toEqual(["first-enter"]);
      } finally {
        releaseFirst.resolve();
        await Promise.all([first, second]);
      }
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    });
  });

  it("reclaims process-bound lifecycle work after its process is killed", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-killed-owner" }, async (state) => {
      await withLeaseChildren(async (children) => {
        const script = await state.writeText(
          "killed-lease.mts",
          `
          import { withPluginLifecycleLease } from ${JSON.stringify(pluginModuleUrl("plugin-lifecycle-lease.ts"))};
          const env = { ...process.env, OPENCLAW_STATE_DIR: process.argv[2] };
          await withPluginLifecycleLease({ env, processBound: true }, async () => {
            process.stdout.write("ready\\n");
            await new Promise(() => {});
          });
        `,
        );
        const holder = await runLeaseChild(children, script, [state.stateDir]);
        await holder.ready;
        await stopChildProcess(holder.child, 5_000, { force: true });
        await holder.completed.catch(() => {});
        children.delete(holder);
        await expect(
          withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "recovered"),
        ).resolves.toBe("recovered");
      });
    });
  });

  it("reloads install records after waiting for another process", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-record-cache" }, async (state) => {
      await withLeaseChildren(async (children) => {
        const leaseModuleUrl = pluginModuleUrl("plugin-lifecycle-lease.ts");
        const recordsModuleUrl = pluginModuleUrl("installed-plugin-index-records.ts");
        const indexModuleUrl = pluginModuleUrl("installed-plugin-index-store.ts");
        const writeModuleUrl = pluginModuleUrl("installed-plugin-index-store-write.ts");
        const alphaGoMarker = state.path("alpha-go");
        const betaGoMarker = state.path("beta-go");
        const releaseAlphaMarker = state.path("release-alpha");
        // A missing database skips worker startup, so prime an existing empty index.
        await seedInstalledPluginIndex({}, { env: state.env, candidates: [] });
        const childScript = await state.writeText(
          "record-cache-child.mts",
          `
          import assert from "node:assert/strict";
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            loadInstalledPluginIndexInstallRecords,
          } from ${JSON.stringify(recordsModuleUrl)};
          import { readPersistedInstalledPluginIndex } from ${JSON.stringify(indexModuleUrl)};
          import { writePersistedInstalledPluginIndex } from ${JSON.stringify(writeModuleUrl)};
          const [pluginId, stateDir, goMarker, releaseAlphaMarker] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          async function waitForMarker(marker) {
            while (true) {
              try {
                await fs.access(marker);
                return;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
            }
          }
          await loadInstalledPluginIndexInstallRecords();
          const index = await readPersistedInstalledPluginIndex({ env });
          assert(index);
          process.stdout.write("ready\\n");
          await waitForMarker(goMarker);
          if (pluginId === "beta") {
            await assert.rejects(
              withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 0 }, async () => {
                assert.fail("blocked lifecycle callback must not run");
              }),
              { code: "OPENCLAW_STATE_LEASE_HELD" },
            );
            process.stdout.write("held\\n");
          }
          const operation = withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
            process.stdout.write("acquired\\n");
            if (pluginId === "alpha") {
              await waitForMarker(releaseAlphaMarker);
            }
            const records = await loadInstalledPluginIndexInstallRecords();
            process.stdout.write("records:" + Object.keys(records).sort().join(",") + "\\n");
            // Reuse prepared fixture metadata so this test exercises only the cache handoff.
            await writePersistedInstalledPluginIndex({
              ...index,
              installRecords: {
                ...records,
                [pluginId]: {
                  source: "path",
                  spec: pluginId,
                  sourcePath: "/tmp/" + pluginId,
                  installPath: "/tmp/" + pluginId,
                },
              },
            }, { env });
            process.stdout.write("written\\n");
          });
          process.stdout.write("attempted\\n");
          await operation;
          process.stdout.write("released\\n");
        `,
        );

        const alpha = await runLeaseChild(children, childScript, [
          "alpha",
          state.stateDir,
          alphaGoMarker,
          releaseAlphaMarker,
        ]);
        const beta = await runLeaseChild(children, childScript, [
          "beta",
          state.stateDir,
          betaGoMarker,
          releaseAlphaMarker,
        ]);
        await Promise.all([alpha.ready, beta.ready]);
        await fs.writeFile(alphaGoMarker, "go");
        await alpha.waitForPhase("acquired");
        await fs.writeFile(betaGoMarker, "go");
        // Observe real contention before alpha commits; acquisition itself is asynchronous.
        await beta.waitForPhase("held");
        await beta.waitForPhase("attempted");
        expect(beta.phases.has("acquired")).toBe(false);
        await fs.writeFile(releaseAlphaMarker, "release");
        await Promise.all([alpha.completed, beta.completed]);
        expect(beta.phases.has("records:alpha")).toBe(true);

        closeOpenClawStateDatabaseForTest();
        const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
        expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
      });
    });
  });

  it("gives a delayed observer a fresh lease after its writer closes", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-observer" }, async (state) => {
      const resumeObserver = createDeferred();
      let observer: Promise<void> | undefined;
      try {
        await withPluginLifecycleLease({ env: state.env }, async (previous) => {
          observer = resumeObserver.promise.then(() =>
            runOutsidePluginLifecycleLease(() =>
              withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (current) => {
                expect(current).not.toBe(previous);
                expect(current.signal).not.toBe(previous.signal);
                expect(() => previous.assertOwned()).toThrow(OpenClawStateLeaseError);
                current.assertOwned();
              }),
            ),
          );
          void observer.catch(() => {});
        });
        resumeObserver.resolve();
        if (!observer) {
          throw new Error("Expected the writer to schedule its observer");
        }
        await observer;
      } finally {
        resumeObserver.resolve();
        await observer?.catch(() => {});
      }
    });
  });

  it.each([
    { authority: "outer", explicitNestedEnv: false },
    { authority: "nested", explicitNestedEnv: false },
    { authority: "nested", explicitNestedEnv: true },
  ])(
    "fences a nested index commit after $authority authority is revoked (explicit env: $explicitNestedEnv)",
    async ({ authority, explicitNestedEnv }) => {
      await withOpenClawTestState({ label: "plugin-lifecycle-caller-fence" }, async (state) => {
        const preparing = createDeferred();
        const prepared = createDeferred();
        const revoked = new Error("update authority revoked");
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw revoked;
          }
        };
        const writeRecords = (lease: PluginLifecycleLeaseContext, spec: string) =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            { demo: { source: "npm", spec } },
            { env: state.env, candidates: [], lease },
          );
        const options = { env: state.env, waitMs: 0 };
        await withPluginLifecycleLease(options, (lease) => writeRecords(lease, "demo@1.0.0"));
        const before = await readPersistedInstalledPluginIndex({ env: state.env });
        expect(before?.installRecords.demo?.spec).toBe("demo@1.0.0");

        const operation = withPluginLifecycleLease(
          { ...options, ...(authority === "outer" ? { assertCurrent } : {}) },
          async () =>
            withPluginLifecycleLease(
              {
                ...(explicitNestedEnv ? { env: state.env } : {}),
                ...(authority === "nested" ? { assertCurrent } : {}),
              },
              async () =>
                withPluginLifecycleLease({}, async (lease) => {
                  preparing.resolve();
                  await prepared.promise;
                  // The nested writer has already entered; only commit-time authority can fence it.
                  return writeRecords(lease, "demo@2.0.0");
                }),
            ),
        );
        await Promise.race([preparing.promise, operation]);
        current = false;
        prepared.resolve();

        await expect(operation).rejects.toBe(revoked);
        expect(await readPersistedInstalledPluginIndex({ env: state.env })).toEqual(before);
        await withPluginLifecycleLease(options, (lease) => writeRecords(lease, "demo@3.0.0"));
        expect(
          (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords.demo?.spec,
        ).toBe("demo@3.0.0");
      });
    },
  );

  it("retains plugin lease checks when the caller authority is still current", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-plugin-fence" }, async (state) => {
      const controller = new AbortController();
      const assertCurrent = vi.fn();
      let ownershipError: unknown;
      let commitError: unknown;
      await expect(
        withPluginLifecycleLease(
          { env: state.env, signal: controller.signal, assertCurrent },
          async () =>
            withPluginLifecycleLease({}, async (lease) => {
              await fs.stat(state.stateDir);
              controller.abort(new Error("plugin work cancelled"));
              try {
                lease.assertOwned();
              } catch (error) {
                ownershipError = error;
              }
              try {
                await writePersistedInstalledPluginIndexInstallRecordsWithLease(
                  { demo: { source: "npm", spec: "demo@2.0.0" } },
                  { env: state.env, candidates: [], lease },
                );
              } catch (error) {
                commitError = error;
              }
            }),
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      // Assert outside the owner callback: its abort normalization must not mask a failed assertion.
      expect(ownershipError).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(commitError).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(assertCurrent).toHaveBeenCalled();
      expect(await readPersistedInstalledPluginIndex({ env: state.env })).toBeNull();
    });
  });

  it.each(["expired", "revoked"] as const)(
    "refuses publication through a %s process-owned lifecycle capability",
    async (reason) => {
      await withOpenClawTestState({ label: "plugin-lifecycle-current" }, async (state) => {
        const caller = new AbortController();
        const refusal = new Error("Synthetic caller revoked");
        const publish = vi.fn();
        await expect(
          withPluginLifecycleLease(
            {
              env: state.env,
              processBound: true,
              leaseMs: 1_000,
              assertCurrent: () => caller.signal.throwIfAborted(),
            },
            async (lease) => {
              await nextTurn();
              const clock =
                reason === "expired"
                  ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000)
                  : undefined;
              if (reason === "revoked") {
                caller.abort(refusal);
              }
              try {
                lease.assertCurrent();
                lease.assertOwned();
                publish();
              } finally {
                clock?.mockRestore();
              }
            },
          ),
        ).rejects.toMatchObject(
          reason === "expired" ? { code: "OPENCLAW_STATE_LEASE_LOST" } : refusal,
        );
        expect(publish).not.toHaveBeenCalled();
      });
    },
  );

  it("preserves an operation failure and releases the plugin lease after caller revocation", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-failed-cleanup" }, async (state) => {
      const failure = new Error("plugin preparation failed");
      let current = true;
      await expect(
        withPluginLifecycleLease(
          {
            env: state.env,
            assertCurrent: () => {
              if (!current) {
                throw new Error("update authority revoked");
              }
            },
          },
          async () => {
            await fs.stat(state.stateDir);
            current = false;
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      await expect(
        withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "released"),
      ).resolves.toBe("released");
    });
  });
});
