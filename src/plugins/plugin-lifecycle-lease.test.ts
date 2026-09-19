import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { OpenClawStateLeaseError, withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  getPluginCache,
  getProcessPluginCache,
  resetPluginCache,
  retirePluginCache,
  waitForPluginCacheRetirement,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "./plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

type LeaseChild = ChildProcessByStdio<null, Readable, Readable>;
type LeaseChildRun = {
  child: LeaseChild;
  ready: Promise<void>;
  completed: Promise<void>;
  phases: ReadonlySet<string>;
  waitForPhase: (phase: string) => Promise<void>;
  output: () => string;
};

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function terminateLeaseChild(child: LeaseChild): Promise<void> {
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("close", onClose);
      resolve();
      return;
    }
    child.kill("SIGKILL");
  });
}

async function withLeaseChildren<T>(fn: (children: Set<LeaseChildRun>) => Promise<T>): Promise<T> {
  const children = new Set<LeaseChildRun>();
  try {
    try {
      return await fn(children);
    } finally {
      await Promise.all(
        Array.from(children, async ({ child, completed }) => {
          await terminateLeaseChild(child);
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

function runLeaseChild(
  children: Set<LeaseChildRun>,
  scriptPath: string,
  args: string[],
): LeaseChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  const phases = new Set<string>();
  const phaseWaiters = new Map<string, ReturnType<typeof createDeferred<void>>>();

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      phases.add(line);
      phaseWaiters.get(line)?.resolve();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(`failed to start lease child ${args[0]}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lease child ${args[0]} exited ${code ?? signal}`));
      }
    });
  });
  void completed.catch(() => {});
  const waitForPhase = (phase: string): Promise<void> => {
    if (phases.has(phase)) {
      return Promise.resolve();
    }
    const waiter = phaseWaiters.get(phase) ?? createDeferred();
    phaseWaiters.set(phase, waiter);
    return Promise.race([
      waiter.promise,
      completed.then(() => {
        throw new Error(`lease child ${args[0]} exited before ${phase}`);
      }),
    ]);
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
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "preserves operation and cleanup outcomes (run failure: %s, cleanup failure: %s)",
    async (failRun, failCleanup) => {
      await withOpenClawTestState({ label: "plugin-lifecycle-outcome" }, async (state) => {
        const runError = new Error("operation failed");
        const cleanupError = new Error("cleanup failed");
        const value = {};
        let cache: ReturnType<typeof getPluginCache> | undefined;
        const operation = withPluginLifecycleLease({ env: state.env }, async () => {
          cache = getPluginCache();
          const instance = new PluginInstance("lease-cleanup");
          instance.lifecycle.onDispose(() => {
            if (failCleanup) {
              throw cleanupError;
            }
          });
          cache.setupModules.set(instance.pluginId, instance);
          if (failRun) {
            throw runError;
          }
          return value;
        });
        const [outcome] = await Promise.allSettled([operation]);
        expect(cache).toBeDefined();
        const cleanup = await retirePluginCache(cache!);
        expect(cleanup.failures.map((failure) => failure.error)).toEqual(
          failCleanup ? [cleanupError] : [],
        );
        if (failRun) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect(outcome.reason).toBe(runError);
          }
        } else {
          expect(outcome.status).toBe("fulfilled");
          if (outcome.status === "fulfilled") {
            expect(outcome.value).toBe(value);
          }
        }
        await expect(
          withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => value),
        ).resolves.toBe(value);
      });
    },
  );

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
        const processInstance = new PluginInstance("process-cleanup");
        processInstance.lifecycle.onDispose(async () => {
          await releaseProcess.promise;
          throw processError;
        });
        processCache = getProcessPluginCache();
        processCache.setupModules.set(processInstance.pluginId, processInstance);
        resetPluginCache();
        const operationInstance = new PluginInstance("operation-cleanup");
        operationInstance.lifecycle.onDispose(() => {
          operationCleanupEntered.resolve();
          throw operationError;
        });
        operationCache = getPluginCache();
        operationCache.setupModules.set(operationInstance.pluginId, operationInstance);
        throw runError;
      });
      const completion = Promise.allSettled([operation]).then(([outcome]) => {
        settled = true;
        return outcome;
      });
      try {
        await operationCleanupEntered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
      } finally {
        releaseProcess.resolve();
        await completion;
        await waitForPluginCacheRetirement().catch(() => {});
      }
      const outcome = await completion;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBe(runError);
      }
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
          const instance = new PluginInstance("revoked-cleanup");
          instance.lifecycle.onDispose(async () => {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          });
          getPluginCache().setupModules.set(instance.pluginId, instance);
          controller.abort(refusal);
          lease.assertOwned();
        },
      );
      const completion = Promise.allSettled([operation]);
      try {
        await cleanupEntered.promise;
        await expect(
          withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "acquired"),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
      } finally {
        releaseCleanup.resolve();
        await completion;
      }
      const [outcome] = await completion;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBe(refusal);
      }
      await expect(
        withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async () => "acquired"),
      ).resolves.toBe("acquired");
    });
  });

  it.each([
    ["one state directory", false],
    ["an explicit database path across different state directories", true],
  ])("serializes lifecycle work sharing %s", async (_label, explicitPath) => {
    await withOpenClawTestState({ label: "plugin-lifecycle-lease" }, async (state) => {
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const events: string[] = [];
      const leaseOptions = (caller: string) => ({
        env: explicitPath ? { ...state.env, OPENCLAW_STATE_DIR: state.path(caller) } : state.env,
        ...(explicitPath ? { path: state.path("shared-plugin-lifecycle.sqlite") } : {}),
        leaseMs: 1_000,
        waitMs: 3_000,
      });

      vi.useFakeTimers();
      try {
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
          await vi.advanceTimersByTimeAsync(100);
          expect(events).toEqual(["first-enter"]);
        } finally {
          releaseFirst.resolve();
          // Drive the pending acquisition retry after the first owner releases.
          await vi.advanceTimersByTimeAsync(250);
          await Promise.all([first, second]);
        }
        expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("serializes lifecycle work across processes", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-processes" }, async (state) => {
      await withLeaseChildren(async (children) => {
        const releaseMarker = state.path("release-first");
        const secondMarker = state.path("second-entered");
        const secondResult = state.path("second-result");
        const leaseModuleUrl = pathToFileURL(
          path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
        ).href;
        const childScript = await state.writeText(
          "lease-child.mts",
          `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          const [role, stateDir, releaseMarker, secondMarker, secondResult] = process.argv.slice(2);
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          if (role === "second") {
            process.stdout.write("ready\\n");
            try {
              await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 0 }, async () => {
                await fs.writeFile(secondMarker, "entered");
              });
              await fs.writeFile(secondResult, "acquired");
            } catch (error) {
              await fs.writeFile(secondResult, error?.code ?? String(error));
            }
          } else {
            await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
              process.stdout.write("ready\\n");
              while (true) {
                try {
                  await fs.access(releaseMarker);
                  break;
                } catch {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 25);
                  });
                }
              }
            });
          }
        `,
        );

        const childArgs = [state.stateDir, releaseMarker, secondMarker, secondResult];
        const first = runLeaseChild(children, childScript, ["first", ...childArgs]);
        await first.ready;
        const second = runLeaseChild(children, childScript, ["second", ...childArgs]);
        await second.ready;
        // Wait for the child to close so its result write is fully flushed before
        // reading; file existence alone can race with the write after open().
        await second.completed;

        let assertionError: unknown;
        try {
          await expect(fs.readFile(secondResult, "utf8")).resolves.toBe(
            "OPENCLAW_STATE_LEASE_TIMEOUT",
          );
          await expect(fs.access(secondMarker)).rejects.toMatchObject({ code: "ENOENT" });
        } catch (error) {
          assertionError = error;
        } finally {
          await fs.writeFile(releaseMarker, "release");
        }
        await Promise.all([first.completed, second.completed]);
        if (assertionError) {
          throw assertionError instanceof Error
            ? assertionError
            : new Error("cross-process lease assertion failed", { cause: assertionError });
        }
      });
    });
  });

  it("reloads install records after waiting for another process", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-record-cache" }, async (state) => {
      await withLeaseChildren(async (children) => {
        const leaseModuleUrl = pathToFileURL(
          path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
        ).href;
        const recordsModuleUrl = pathToFileURL(
          path.resolve("src/plugins/installed-plugin-index-records.ts"),
        ).href;
        const seedModuleUrl = pathToFileURL(
          path.resolve("src/plugins/test-helpers/installed-plugin-index.ts"),
        ).href;
        const alphaGoMarker = state.path("alpha-go");
        const betaGoMarker = state.path("beta-go");
        const releaseAlphaMarker = state.path("release-alpha");
        // This race owns two synthetic records, not bundled inventory discovery.
        const bundledDir = state.path("empty-bundled-plugins");
        await fs.mkdir(bundledDir);
        // A missing database skips worker startup, so prime an existing empty index.
        await seedInstalledPluginIndex({}, { env: state.env, candidates: [] });
        const childScript = await state.writeText(
          "record-cache-child.mts",
          `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            loadInstalledPluginIndexInstallRecords,
          } from ${JSON.stringify(recordsModuleUrl)};
          import { seedInstalledPluginIndex } from ${JSON.stringify(seedModuleUrl)};
          const [pluginId, stateDir, goMarker, releaseAlphaMarker, bundledDir] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
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
          process.stdout.write("ready\\n");
          await waitForMarker(goMarker);
          const operation = withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
            process.stdout.write("acquired\\n");
            if (pluginId === "alpha") {
              await waitForMarker(releaseAlphaMarker);
            }
            const records = await loadInstalledPluginIndexInstallRecords();
            process.stdout.write("records:" + Object.keys(records).sort().join(",") + "\\n");
            await seedInstalledPluginIndex({
              ...records,
              [pluginId]: {
                source: "path",
                spec: pluginId,
                sourcePath: "/tmp/" + pluginId,
                installPath: "/tmp/" + pluginId,
              },
            });
            process.stdout.write("written\\n");
          });
          process.stdout.write("attempted\\n");
          await operation;
          process.stdout.write("released\\n");
        `,
        );

        const alpha = runLeaseChild(children, childScript, [
          "alpha",
          state.stateDir,
          alphaGoMarker,
          releaseAlphaMarker,
          bundledDir,
        ]);
        const beta = runLeaseChild(children, childScript, [
          "beta",
          state.stateDir,
          betaGoMarker,
          releaseAlphaMarker,
          bundledDir,
        ]);
        await Promise.all([alpha.ready, beta.ready]);
        await fs.writeFile(alphaGoMarker, "go");
        await alpha.waitForPhase("acquired");
        await fs.writeFile(betaGoMarker, "go");
        // Acquisition attempts before yielding; alpha remains held until beta is waiting.
        await beta.waitForPhase("attempted");
        expect(beta.phases.has("acquired")).toBe(false);
        await fs.writeFile(releaseAlphaMarker, "release");
        await Promise.all([alpha.completed, beta.completed]);

        closeOpenClawStateDatabaseForTest();
        const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
        expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
      });
    });
  });

  it("gives a delayed observer fresh physical lease ancestry after its writer closes", async () => {
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
                await withOpenClawStateLease(
                  {
                    scope: "core:test-plugin-observer",
                    key: "capture",
                    database: { scope: "shared", options: { env: state.env } },
                    leaseMs: 10_000,
                    waitMs: 0,
                  },
                  async (nested) => {
                    if (!nested.withDatabaseFileExclusion) {
                      throw new Error("Expected the canonical file-exclusion capability");
                    }
                    const capturedSize = await nested.withDatabaseFileExclusion(
                      async (assertCurrent) => {
                        const bytes = await fs.readFile(current.databasePath);
                        assertCurrent();
                        current.assertOwned();
                        nested.assertOwned();
                        return bytes.byteLength;
                      },
                    );
                    expect(capturedSize).toBeGreaterThan(0);
                  },
                );
                current.assertOwned();
                expect(() => previous.assertOwned()).toThrow(OpenClawStateLeaseError);
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

  it("reuses the active lease for nested lifecycle work", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-reentrant" }, async (state) => {
      const events: string[] = [];
      await withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 0 },
        async (outerLease) => {
          events.push("outer");
          await withPluginLifecycleLease({}, async (innerLease) => {
            events.push("inner");
            expect(innerLease).toBe(outerLease);
            expect(innerLease.databasePath).toBe(
              path.resolve(state.stateDir, "state", "openclaw.sqlite"),
            );
          });
        },
      );
      expect(events).toEqual(["outer", "inner"]);
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
