import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { gatewayKernelLogs } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";
import * as workers from "./server-worker-environment-startup.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

// Prepare the cold module graph outside the real lock-wait proof.
await import("./server-start.js");

const recoveryOperations = [
  "recoverWorkerSessionToolOperationsAfterRestart",
  "clearLocalTurnClaimsAfterRestartAsync",
  "pruneOrphanedWorkspaceReconciliations",
] as const;

type RecoveryProof = {
  operation: (typeof recoveryOperations)[number];
  attempts: number;
  retryObserved: Deferred<"retry">;
  blocker?: DatabaseSync;
};

it.for(["release", "exhaust", "fatal"] as const)(
  "worker startup recovery: %s",
  { timeout: 90_000 },
  async (mode, { signal }) => {
    await using state = await createStartupTestState(`worker-recovery-${mode}`, {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    });
    await state.writeConfig({
      gateway: { mode: "local", auth: { mode: "token", token: "worker-recovery-test-token" } },
      plugins: { enabled: false },
      cron: { enabled: false, triggers: { enabled: false } },
      discovery: { mdns: { mode: "off" } },
      logging: { file: state.path("gateway.log") },
    });
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const recoveries: RecoveryProof[] = (
      mode === "release" ? recoveryOperations : [recoveryOperations[0]]
    ).map((operation) => ({
      operation,
      attempts: 0,
      retryObserved: createDeferredCore<"retry">(),
    }));
    const ready = createDeferredCore();
    const info = gatewayKernelLogs.log.info.bind(gatewayKernelLogs.log);
    using _ = vi.spyOn(gatewayKernelLogs.log, "info").mockImplementation((message, meta) => {
      info(message, meta);
      if (message === "gateway ready") {
        ready.resolve();
      }
    });
    const failure = new Error("disk I/O error");
    let server: GatewayServer | undefined;
    const load = workers.loadGatewayWorkerEnvironmentStartupState;
    const loader = vi
      .spyOn(workers, "loadGatewayWorkerEnvironmentStartupState")
      .mockImplementation(async () => {
        const startup = await load();
        const store = startup.placementStore;
        // These stages run in order; each must independently recover from a real lock.
        for (const recovery of recoveries) {
          const { operation } = recovery;
          const contend = async <T>(recover: () => Promise<T>): Promise<T> => {
            recovery.attempts += 1;
            if (mode === "fatal") {
              throw failure;
            }
            if (recovery.attempts === 1) {
              recovery.blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
              recovery.blocker.exec("BEGIN IMMEDIATE");
            }
            try {
              return await recover();
            } catch (error) {
              recovery.retryObserved.resolve("retry");
              throw error;
            }
          };
          if (
            operation === "recoverWorkerSessionToolOperationsAfterRestart" ||
            operation === "clearLocalTurnClaimsAfterRestartAsync"
          ) {
            const recover = store[operation].bind(store);
            vi.spyOn(store, operation).mockImplementation(() => contend(recover));
          } else {
            const recover = store[operation].bind(store);
            vi.spyOn(store, operation).mockImplementation(() => contend(recover));
          }
        }
        return startup;
      });
    const { startGatewayServer } = await import("./server.js");
    const starting = startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        ...gatewayStartupOptions("worker-recovery-test-token"),
        sidecarStartup: "start",
      }),
    ).then((value) => (server = value));
    void starting.catch(() => {});
    try {
      if (mode !== "fatal") {
        for (const recovery of recoveries) {
          await expect(Promise.race([recovery.retryObserved.promise, starting])).resolves.toBe(
            "retry",
          );
          expect(recovery.blocker?.isTransaction).toBe(true);
          if (mode === "release") {
            recovery.blocker!.exec("ROLLBACK");
          }
        }
      }
      if (mode === "release") {
        await starting.then((value) => value.startupSettled);
        // Recovery can outlive startup settlement; wait for traffic admission.
        await withinTest(ready.promise, signal);
        expect((await fetch(`http://127.0.0.1:${claim.port}/readyz`)).status).toBe(200);
      } else if (mode === "fatal") {
        await expect(starting).rejects.toBe(failure);
      } else {
        await expect(starting).rejects.toThrow(
          /database is locked by another process or connection.*openclaw doctor.*openclaw gateway status --deep/,
        );
      }
      for (const recovery of recoveries) {
        expect(recovery.attempts, recovery.operation).toBe(
          { release: 2, fatal: 1, exhaust: 5 }[mode],
        );
      }
    } finally {
      for (const recovery of recoveries) {
        recovery.blocker?.close();
      }
      await starting.catch(() => {});
      await server?.close({ reason: "worker recovery contention proof complete" });
      await claim.release();
      loader.mockRestore();
    }
  },
);
