import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import { runWatchMain } from "../../scripts/watch-node.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigFileAdapter } from "../config/source-file.js";
import { createDeferredCore } from "../shared/deferred.js";

// Keep Root and watch in the same external module registry. This instruments
// delivery and lifetime without substituting the native backend or scans.
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function observeBackend() {
  const subscriptions: observation.WatchSubscription[] = [];
  const invalidations: observation.WatchInvalidation[] = [];
  let operation: { owner: "config" | "dev"; action: string } | undefined;
  const failed = createDeferredCore<never>();
  void failed.promise.catch(() => {});
  const actual = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((root, options) => {
    const subscription = actual(root, {
      ...options,
      onInvalidate(invalidation) {
        invalidations.push(invalidation);
        if (operation) {
          console.log(
            JSON.stringify({
              ...operation,
              reason: invalidation.reason,
              changes: invalidation.changes?.length,
              modes: subscriptions.map((entry) => entry.health().mode),
            }),
          );
        }
        options.onInvalidate(invalidation);
      },
      onHealth(health) {
        if (health.state === "unavailable") {
          failed.reject(health.failure?.error ?? new Error("Observation unavailable"));
        }
        options.onHealth?.(health);
      },
    });
    subscriptions.push(subscription);
    return subscription;
  });
  return {
    subscriptions,
    invalidations,
    failed: failed.promise,
    beginAction(owner: "config" | "dev", action: string) {
      operation = { owner, action };
      return invalidations.length;
    },
    assertClosed() {
      expect(subscriptions.length).toBeGreaterThan(0);
      expect(subscriptions.every((entry) => entry.health().state === "closed")).toBe(true);
      expect(subscriptions.every((entry) => entry.health().mode === proofMode)).toBe(true);
    },
    assertDelivery(since: number) {
      expect(subscriptions.every((entry) => entry.health().mode === proofMode)).toBe(true);
      expect(invalidations.slice(since).some(isProofInvalidation)).toBe(true);
    },
  };
}

// This explicit live tier pays for real OS delivery, production settling, and
// actual child restarts. Deterministic lifecycle coverage lives in unit tests.
const proofMode = process.env.OPENCLAW_WATCH_PROOF_MODE === "poll" ? "poll" : "events";
function isProofInvalidation(invalidation: observation.WatchInvalidation) {
  // fs-safe emits overflow only after native hints lose bounded path detail;
  // bootstrap and hint-free scans remain reconcile and cannot prove events.
  return proofMode === "poll"
    ? invalidation.reason === "reconcile"
    : invalidation.reason === "event" || invalidation.reason === "overflow";
}
const proofEnv = {
  CHOKIDAR_USEPOLLING: proofMode === "poll" ? "true" : "false",
  CHOKIDAR_INTERVAL: "20",
};

describe(`real ${proofMode} config and developer observation on ${process.platform}`, () => {
  it("reloads a real edit, deletion, and replacement, then joins config close", async () => {
    const backend = observeBackend();
    vi.stubEnv("CHOKIDAR_USEPOLLING", proofEnv.CHOKIDAR_USEPOLLING);
    vi.stubEnv("CHOKIDAR_INTERVAL", proofEnv.CHOKIDAR_INTERVAL);
    const directory = temp.make("openclaw-config-os-proof-");
    const filename = path.join(directory, "openclaw.json");
    await fs.writeFile(filename, JSON.stringify({ value: "before" }));
    const ready = createDeferredCore();
    let expected: string | null = null;
    let changed = createDeferredCore<string | null>();
    void changed.promise.catch(() => {});
    const reads: Array<Promise<void>> = [];
    const applied: Array<string | null> = [];
    const adapter = createConfigFileAdapter({
      path: filename,
      onReady: () => ready.resolve(),
      onChange() {
        reads.push(
          (async () => {
            let value: string | null;
            try {
              value = (JSON.parse(await fs.readFile(filename, "utf8")) as { value: string }).value;
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
              }
              value = null;
            }
            applied.push(value);
            if (value === expected) {
              changed.resolve(value);
            }
          })().catch(changed.reject),
        );
      },
      log: {
        warn() {},
        error(message) {
          ready.reject(new Error(message));
          changed.reject(new Error(message));
        },
      },
    });
    cleanup.push(async () => {
      await adapter.stop();
      await Promise.all(reads);
    });
    adapter.start();
    await Promise.race([ready.promise, backend.failed]);
    for (const value of ["edited", null, "restored", "replacement"]) {
      expected = value;
      changed = createDeferredCore<string | null>();
      void changed.promise.catch(() => {});
      const since = backend.beginAction("config", value ?? "delete");
      if (value === null) {
        await fs.unlink(filename);
      } else if (value === "replacement") {
        const replacement = path.join(directory, "replacement.json");
        await fs.writeFile(replacement, JSON.stringify({ value }));
        await fs.rename(replacement, filename);
      } else {
        await fs.writeFile(filename, JSON.stringify({ value }));
      }
      expect(await Promise.race([changed.promise, backend.failed])).toBe(value);
      backend.assertDelivery(since);
    }
    await adapter.stop();
    await Promise.all(reads);
    expect(applied).toEqual(expect.arrayContaining(["edited", null, "replacement"]));
    backend.assertClosed();
    console.log(
      JSON.stringify({
        owner: "config",
        platform: process.platform,
        mode: proofMode,
        edit: true,
        delete: true,
        replacement: true,
        close: true,
      }),
    );
  }, 20_000);

  it("restarts a real child for an edit, deletion, and replacement, then joins source close", async () => {
    const backend = observeBackend();
    const directory = temp.make("openclaw-dev-os-proof-");
    const filename = path.join(directory, "src", "index.ts");
    await fs.mkdir(path.dirname(filename));
    await fs.mkdir(path.join(directory, "dist"));
    await fs.writeFile(path.join(directory, "dist", "entry.js"), "");
    await fs.writeFile(filename, "before");
    const host = Object.assign(new EventEmitter(), {
      pid: process.pid,
      execPath: process.execPath,
      platform: process.platform,
      stdin: { isTTY: true },
      stderr: { write: () => true },
    });
    const children: ChildProcess[] = [];
    const started = createDeferredCore<number>();
    let pending:
      | {
          value: string | null;
          since: number;
          completion: ReturnType<typeof createDeferredCore<number>>;
        }
      | undefined;
    let observer: ReturnType<typeof createSourceObserver> | undefined;
    const running = runWatchMain({
      cwd: directory,
      env: { ...process.env, ...proofEnv },
      args: ["status"],
      lockDisabled: true,
      process: host as unknown as NodeJS.Process,
      watchPaths: ["src"],
      pathClassifier: {
        refreshGeneratedPluginAssetPaths() {},
        isRestartRelevantRunNodePath: () => true,
      },
      createWatcher(paths, options) {
        observer = createSourceObserver(paths, options);
        return observer;
      },
      spawn(command, _args, options) {
        const invalidatedBeforeSpawn = backend.invalidations.length;
        const child = spawn(
          command,
          [
            "-e",
            "process.on('SIGTERM', () => process.exit(143)); process.on('message', () => {}); let value; try { value = require('node:fs').readFileSync('src/index.ts', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; value = null; } process.send({ value });",
          ],
          {
            ...options,
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          },
        );
        const initial = children.length === 0;
        children.push(child);
        child.once("message", (message: unknown) => {
          if (initial) {
            started.resolve(child.pid!);
          }
          if (
            pending &&
            typeof message === "object" &&
            message !== null &&
            "value" in message &&
            message.value === pending.value &&
            backend.invalidations
              .slice(pending.since, invalidatedBeforeSpawn)
              .some(isProofInvalidation)
          ) {
            // Late readiness from an earlier restart cannot prove this edit.
            pending.completion.resolve(child.pid!);
          }
        });
        child.once("error", (error) => {
          started.reject(error);
          pending?.completion.reject(error);
        });
        return child;
      },
    });
    void running.catch((error: unknown) => {
      started.reject(error);
      pending?.completion.reject(error);
    });
    cleanup.push(async () => {
      host.emit("SIGTERM");
      await running;
    });
    let previousPid = await started.promise;
    await Promise.race([observer!.ready, backend.failed]);
    for (const action of ["edit", "delete", "restore", "replacement"]) {
      const since = backend.beginAction("dev", action);
      const value =
        action === "delete"
          ? null
          : action === "edit"
            ? "edited"
            : action === "restore"
              ? "restored"
              : "replacement";
      const completion = createDeferredCore<number>();
      pending = { value, since, completion };
      if (action === "delete") {
        await fs.unlink(filename);
      } else if (action === "replacement") {
        const replacement = path.join(directory, "replacement.ts");
        await fs.writeFile(replacement, "replacement");
        await fs.rename(replacement, filename);
      } else {
        await fs.writeFile(filename, action === "restore" ? "restored" : "edited");
      }
      const nextPid = await Promise.race([completion.promise, backend.failed]);
      expect(nextPid).not.toBe(previousPid);
      previousPid = nextPid;
      backend.assertDelivery(since);
      pending = undefined;
    }
    host.emit("SIGTERM");
    await expect(running).resolves.toBe(143);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    backend.assertClosed();
    console.log(
      JSON.stringify({
        owner: "dev",
        platform: process.platform,
        mode: proofMode,
        edit: true,
        delete: true,
        replacement: true,
        close: true,
      }),
    );
  }, 20_000);
});
