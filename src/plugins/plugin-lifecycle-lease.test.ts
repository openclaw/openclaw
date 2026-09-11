import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  getPluginCache,
  getProcessPluginCache,
  resetPluginCache,
  retirePluginCache,
  waitForPluginCacheRetirement,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

type LeaseChild = ChildProcessByStdio<null, Readable, Readable>;

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

async function withLeaseChildren<T>(fn: (children: Set<LeaseChild>) => Promise<T>): Promise<T> {
  const children = new Set<LeaseChild>();
  try {
    return await fn(children);
  } finally {
    await Promise.all(Array.from(children, terminateLeaseChild));
  }
}

function runLeaseChild(
  children: Set<LeaseChild>,
  scriptPath: string,
  args: string[],
): { ready: Promise<void>; completed: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    if (!readySettled && lines.includes("ready")) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      children.delete(child);
      const failure = new Error(`failed to start lease child: ${error.message}`, {
        cause: error,
      });
      if (!readySettled) {
        readySettled = true;
        rejectReady(failure);
      }
      reject(failure);
    });
    child.once("close", (code, signal) => {
      children.delete(child);
      const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(`lease child exited before readiness (${code ?? signal})\n${output}`),
        );
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lease child exited ${code ?? signal}\n${output}`));
      }
    });
  });
  void completed.catch(() => {});
  return { ready, completed };
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
        const goMarker = state.path("go");
        // This race owns two synthetic records, not bundled inventory discovery.
        const bundledDir = state.path("empty-bundled-plugins");
        await fs.mkdir(bundledDir);
        const childScript = await state.writeText(
          "record-cache-child.mts",
          `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            loadInstalledPluginIndexInstallRecords,
            writePersistedInstalledPluginIndexInstallRecords,
          } from ${JSON.stringify(recordsModuleUrl)};
          const [pluginId, stateDir, goMarker, bundledDir] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          await loadInstalledPluginIndexInstallRecords();
          process.stdout.write("ready\\n");
          while (true) {
            try {
              await fs.access(goMarker);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
            const records = await loadInstalledPluginIndexInstallRecords();
            await writePersistedInstalledPluginIndexInstallRecords({
              ...records,
              [pluginId]: {
                source: "path",
                spec: pluginId,
                sourcePath: "/tmp/" + pluginId,
                installPath: "/tmp/" + pluginId,
              },
            });
          });
        `,
        );

        const alpha = runLeaseChild(children, childScript, [
          "alpha",
          state.stateDir,
          goMarker,
          bundledDir,
        ]);
        const beta = runLeaseChild(children, childScript, [
          "beta",
          state.stateDir,
          goMarker,
          bundledDir,
        ]);
        await Promise.all([alpha.ready, beta.ready]);
        await fs.writeFile(goMarker, "go");
        await Promise.all([alpha.completed, beta.completed]);

        closeOpenClawStateDatabaseForTest();
        const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
        expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
      });
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
});
