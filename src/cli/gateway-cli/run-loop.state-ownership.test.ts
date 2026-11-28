import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import {
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
} from "../../infra/restart.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import { runGatewayLoop } from "./run-loop.js";
import {
  createGatewayServer,
  createLifecycleGate,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

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
  await stateDb.closeOpenClawStateDatabaseAsync();
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy();
  resetGatewayWorkAdmission();
  vi.unstubAllEnvs();
});

it.each(["none", "automatic", "manual"] as const)(
  "reacquires state after SIGUSR2 closes its scope (config recovery: %s)",
  async (recovery) => {
    const stateDir = tempDirs.make("openclaw-restart-state-owner-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", `${stateDir}/openclaw.json`);
    for (const name of SUPERVISOR_HINT_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
    setGatewayRestartPolicy({ allowExternal: true });
    const context = new AsyncLocalStorage<string>();
    const reloadWork = new AsyncWorkScope();
    const initialOwner = createDeferred<string | undefined>();
    const restartedOwner = createDeferred<string | undefined>();
    const closing = createLifecycleGate();
    const configReadError = Object.assign(new Error("config read failed"), {
      code: "CONFIG_READ_FAILED",
    });
    const resolveRestartPort = vi.fn(async () => 43822);
    if (recovery !== "none") {
      resolveRestartPort.mockRejectedValueOnce(configReadError);
    }
    const manualRecovery = createDeferred();
    const onRestartStartupFailure = vi.fn(async (error: unknown) => {
      expect(error).toBe(configReadError);
      expect(readGatewayOwnerLease({ current: true })).toBeUndefined();
      if (recovery === "manual") {
        manualRecovery.resolve();
        return undefined;
      }
      return "completed" as const;
    });
    let starts = 0;
    const ownerPorts: Array<number | undefined> = [];
    let closeContext: string | undefined;
    const requestRestart = () => requestGatewayRestartWithSignalAdmission("config reload: fixture");

    await withIsolatedSignals(async ({ captureSignal }) => {
      const loop = context.run("gateway-loop", () =>
        runGatewayLoop({
          // This port is lease metadata only; the fixture opens no listener.
          lockPort: 43821,
          resolveRestartPort,
          onRestartStartupFailure,
          start: async () => {
            stateDb.openOpenClawStateDatabase();
            const lease = readGatewayOwnerLease({ current: true });
            const owner = lease?.owner;
            ownerPorts.push(lease?.port);
            (starts++ === 0 ? initialOwner : restartedOwner).resolve(owner);
            return createGatewayServer(async () => {
              closeContext = context.getStore();
              await reloadWork.drain();
              await closing.wait();
              await drainGlobalSingletonLifecycleState("restart");
            });
          },
        }),
      );
      const waitFor = <T>(gate: PromiseLike<T>, phase: string) =>
        awaitGateBeforeSettlement(gate, loop, `Gateway exited before ${phase}`);
      const first = await waitFor(initialOwner.promise, "initial startup");
      const stop = captureSignal("SIGINT");
      try {
        expect(first).toBeTruthy();
        expect(context.run("config-reload", () => reloadWork.run(requestRestart))).toEqual({
          status: "emitted",
        });
        await waitFor(closing.entered, "closing");
        expect({ aborted: reloadWork.signal.aborted, starts }).toEqual({
          aborted: true,
          starts: 1,
        });
        // Delayed close retains real custody; another startup cannot enter it.
        await expect(acquireGatewayLock({ timeoutMs: 0 })).rejects.toThrow(
          "OpenClaw state database is busy",
        );
        closing.release();
        if (recovery === "manual") {
          await waitFor(manualRecovery.promise, "manual startup recovery");
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
          captureSignal("SIGUSR2")();
        }
        const second = await waitFor(restartedOwner.promise, "reacquiring state ownership");
        expect(second).toBeTruthy();
        expect(second).not.toBe(first);
        expect(ownerPorts).toEqual([43821, 43822]);
        expect(onRestartStartupFailure).toHaveBeenCalledTimes(recovery === "none" ? 0 : 1);
        expect(closeContext).toBe("gateway-loop");
      } finally {
        closing.release();
        stop();
        await expect(loop).resolves.toBe(0);
      }
      expect(readGatewayOwnerLease({ current: true })).toBeUndefined();
    });
  },
);
