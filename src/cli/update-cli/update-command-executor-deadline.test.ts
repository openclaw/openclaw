import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { resolveCommandProcessSignal } from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "commits native deadline cancellation before joining its direct callback (retained pair: %s)",
  async (retained) => {
    const directory = fs.realpathSync(dirs.make("executor-deadline-"));
    const root = path.join(directory, "install");
    const serviceRoot = retained ? path.join(directory, "service") : undefined;
    fs.mkdirSync(root);
    if (serviceRoot) {
      fs.mkdirSync(serviceRoot);
    }
    const { databasePath, assertDatabasePath } = installPrivateUpdateHandoffStore(directory);
    assertDatabasePath(databasePath);
    const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted = createDeferredCore();
    const finish = createDeferredCore();
    let fence: UpdateRecoveryFence | undefined;
    let signal: AbortSignal | undefined;
    let ended = false;
    const work = withUpdateCommandExecutor(
      "deadline-run",
      async (executor) => {
        fence = await executor.enter(root, { activationTimeoutMs: 1000, serviceRoot });
        signal = resolveCommandProcessSignal();
        admitted.resolve();
        await finish.promise;
        signal!.throwIfAborted();
      },
      { directOriginal: { databasePath } },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
        admitted.resolve();
      });
    try {
      await admitted.promise;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(signal?.reason).toBeInstanceOf(UpdateActivationTimeoutError);
      expect(ended).toBe(false);
      expect(fence!.assertCurrent).toThrow(UpdateActivationTimeoutError);
      for (const key of [root, ...(serviceRoot ? [serviceRoot] : [])]) {
        const cancelled = store.read(key);
        expect(cancelled.kind).toBe("current");
        if (cancelled.kind !== "current") {
          throw new Error("Cancelled custody disappeared before its original callback joined");
        }
        expect(cancelled.lease.version).toBe(4);
        expect(store.acquire(key, "competing-update", { kind: "update" }).kind).toBe("busy");
        expect(store.read(key)).toEqual(cancelled);
      }
    } finally {
      finish.resolve();
      await work;
    }
    expect(await work).toBe(signal!.reason);
    expect(store.read(root)).toEqual({ kind: "absent" });
    if (serviceRoot) {
      expect(store.read(serviceRoot)).toEqual({ kind: "absent" });
    }
  },
);
