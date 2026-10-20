import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import {
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
} from "../../infra/restart.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { runGatewayLoop } from "./run-loop.js";
import { withIsolatedSignals } from "./run-loop.test-support.js";

// Exercise real lock files, lease publication, workers and release inside Vitest.
vi.mock("../../infra/gateway-lock.js", async (original) => {
  const actual = await original<typeof import("../../infra/gateway-lock.js")>();
  return {
    ...actual,
    acquireGatewayLock: (options: Parameters<typeof actual.acquireGatewayLock>[0]) =>
      actual.acquireGatewayLock({ ...options, allowInTests: true }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.unstubAllEnvs();
});

it("reacquires state after SIGUSR2 retires its emitting scope and asynchronously closes the server", async () => {
  const stateDir = tempDirs.make("openclaw-restart-state-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", `${stateDir}/openclaw.json`);
  for (const name of SUPERVISOR_HINT_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
  const context = new AsyncLocalStorage<string>();
  const reloadWork = new AsyncWorkScope();
  const initialOwner = createDeferred<string | undefined>();
  const restartedOwner = createDeferred<string | undefined>();
  const closing = createDeferred();
  const releaseClose = createDeferred();
  let starts = 0;
  let closeContext: string | undefined;

  await withIsolatedSignals(async ({ captureSignal }) => {
    const loop = context.run("gateway-loop", () =>
      runGatewayLoop({
        // This port is lease metadata only; the fixture opens no listener.
        lockPort: 43821,
        start: async () => {
          openOpenClawStateDatabase();
          const owner = readGatewayOwnerLease({ current: true })?.owner;
          (starts++ === 0 ? initialOwner : restartedOwner).resolve(owner);
          return {
            getTailscaleIngressEndpoint: () => undefined,
            startupSettled: Promise.resolve(),
            close: async () => {
              closeContext = context.getStore();
              await reloadWork.drain();
              closing.resolve();
              await releaseClose.promise;
              await drainGlobalSingletonLifecycleState("restart");
            },
          };
        },
      }),
    );
    const first = await awaitGateBeforeSettlement(
      initialOwner.promise,
      loop,
      "Gateway exited before initial startup",
    );
    const stop = captureSignal("SIGINT");
    try {
      expect(first).toBeTruthy();
      expect(
        context.run("config-reload", () =>
          reloadWork.run(() => requestGatewayRestartWithSignalAdmission("config reload: fixture")),
        ),
      ).toEqual({ status: "emitted" });
      await awaitGateBeforeSettlement(closing.promise, loop, "Gateway exited before closing");
      expect(reloadWork.signal.aborted).toBe(true);
      expect(starts).toBe(1);
      // Delayed close retains real custody; another startup cannot enter it.
      await expect(acquireGatewayLock({ timeoutMs: 0 })).rejects.toThrow(
        "OpenClaw state database is busy",
      );
      releaseClose.resolve();
      const second = await awaitGateBeforeSettlement(
        restartedOwner.promise,
        loop,
        "Gateway exited instead of reacquiring state ownership",
      );
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect(closeContext).toBe("gateway-loop");
    } finally {
      releaseClose.resolve();
      stop();
      await loop;
    }
    await expect(loop).resolves.toBe(0);
    expect(readGatewayOwnerLease({ current: true })).toBeUndefined();
  });
});
