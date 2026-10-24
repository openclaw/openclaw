import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginServiceRuntime from "../plugins/services.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import {
  installGatewayHookModuleLoad,
  installGatewaySubagentModuleLoad,
  type GatewayStartupModuleMocks,
} from "./server-startup-module-mocks.test-support.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";
import { createStartupGate } from "./server-startup-state.test-support.js";

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];

export function registerGatewayStartupAdmissionTests(params: {
  start: (
    params: PostAttachParams,
    runtimeDeps?: GatewayStartupModuleMocks,
  ) => ReturnType<typeof startGatewayPostAttachRuntime>;
  createParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
  createRuntimeDeps: (overrides?: Partial<GatewayStartupModuleMocks>) => GatewayStartupModuleMocks;
  startupModuleRestorers: Array<() => void>;
  stopSidecar: (sidecar: GatewayPostReadySidecarHandle) => Promise<void>;
}): void {
  it("does not activate restored recovery when close begins during activation loading", async () => {
    const postReadyWork = createDeferred();
    const tracked: Promise<unknown>[] = [];
    const lifetime = new AbortController();
    const recoveryLoad = createStartupGate();
    const pluginServices = {
      reload: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const startServices = vi
      .spyOn(pluginServiceRuntime, "startPluginServices")
      .mockImplementation(async ({ onHandle }) => {
        onHandle?.(pluginServices);
        return pluginServices;
      });
    params.startupModuleRestorers.push(() => startServices.mockRestore());
    const workerSidecar = { stop: vi.fn(async () => {}) };
    const startWorker = vi.fn(() => workerSidecar);
    const unlockStartupMethods = vi.fn();
    const activateSubagentRegistry = vi.fn(() => ({
      initial: Promise.resolve(),
      pending: new Map(),
      settled: Promise.resolve(),
    }));
    await installGatewaySubagentModuleLoad(
      recoveryLoad.run,
      activateSubagentRegistry,
      params.startupModuleRestorers,
    );
    const onPluginServices = vi.fn();
    const publishedPostReadySidecars = new Set<GatewayPostReadySidecarHandle>();
    const expectStops = (count: number) => {
      for (const { stop } of [workerSidecar, pluginServices, ...publishedPostReadySidecars]) {
        expect(stop).toHaveBeenCalledTimes(count);
      }
    };
    const runtime = await params.start(
      {
        ...params.createParams(),
        sidecarStartup: "defer",
        waitForPostReadyWork: () => postReadyWork.promise,
        trackStartupWork: (run) => {
          const work = run(lifetime.signal);
          tracked.push(work);
          return work;
        },
        isClosing: () => lifetime.signal.aborted,
        startWorkerEnvironmentRuntime: startWorker,
        onGatewayLifetimeSidecars: vi.fn(),
        onPostReadySidecars: (...sidecars) => {
          for (const sidecar of sidecars) {
            const stop = vi.spyOn(sidecar, "stop");
            params.startupModuleRestorers.push(() => stop.mockRestore());
            publishedPostReadySidecars.add(sidecar);
          }
        },
        unlockStartupMethods,
        onPluginServices,
      },
      params.createRuntimeDeps(),
    );

    try {
      await runtime.startupSettled;
      expect(activateSubagentRegistry).not.toHaveBeenCalled();
      expect(startServices).toHaveBeenCalledOnce();
      expect(publishedPostReadySidecars.size).toBe(1);
      postReadyWork.resolve();
      await recoveryLoad.entered;
      lifetime.abort();
      recoveryLoad.release();
      await Promise.allSettled(tracked);

      expect(activateSubagentRegistry).not.toHaveBeenCalled();
      expect(unlockStartupMethods).toHaveBeenCalledOnce();
      expect(startWorker).toHaveBeenCalledOnce();
      expectStops(0);
      expect(onPluginServices).toHaveBeenLastCalledWith(pluginServices);
    } finally {
      lifetime.abort();
      postReadyWork.resolve();
      recoveryLoad.release();
      await Promise.allSettled(tracked);
      if (startWorker.mock.calls.length) {
        await params.stopSidecar(workerSidecar);
      }
      for (const sidecar of publishedPostReadySidecars) {
        await params.stopSidecar(sidecar);
      }
      await pluginServices.stop();
    }
    expectStops(1);
  });

  it.each(["orphans", "gateway_start"] as const)(
    "retires startup %s admission parked behind suspension when the Gateway closes",
    async (stage) => {
      const gatewayStart = vi.fn<PluginHookHandlerMap["gateway_start"]>(async () => {});
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.typedHooks.push({
        pluginId: "startup-suspension-test",
        hookName: "gateway_start",
        handler: gatewayStart,
        source: "startup-suspension-test",
      });
      const postReadyWork = createDeferred();
      const hookLoad = createStartupGate();
      const connectionWork = new GatewayConnectionWork();
      const refreshStarted = createDeferred();
      const refresh = vi.fn(async () => {
        refreshStarted.resolve();
        return null;
      });
      const sidecarsReady = vi.fn();
      // The orphan row isolates recovery admission; the hook row owns hook admission.
      if (stage === "orphans") {
        pluginRegistry.typedHooks.length = 0;
        hookLoad.release();
      }
      await installGatewayHookModuleLoad(hookLoad.run, params.startupModuleRestorers);
      const trackStartupWork: PostAttachParams["trackStartupWork"] = (run) => {
        const operation = Promise.resolve().then(() => run(connectionWork.signal));
        return connectionWork.track(() => operation);
      };
      const runtime = await trackStartupWork(() =>
        params.start(
          params.createParams({
            pluginRegistry,
            isClosing: () => connectionWork.isClosing,
            trackStartupWork,
            onSidecarsReady: sidecarsReady,
            waitForPostReadyWork: () => postReadyWork.promise,
          }),
          params.createRuntimeDeps({
            refreshLatestUpdateRestartSentinel: refresh,
          }),
        ),
      );
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
      const admissionParked = createDeferred();
      const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation((run, origin, signal) => {
          const work = runWithAdmission(run, origin, signal);
          if (
            origin ===
            (stage === "orphans" ? "startup:main-session-orphans" : "hooks:gateway-start")
          ) {
            admissionParked.resolve();
          }
          return work;
        });
      try {
        expect(sidecarsReady).not.toHaveBeenCalled();
        if (stage === "gateway_start") {
          postReadyWork.resolve();
          await hookLoad.entered;
          await refreshStarted.promise;
        }
        suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension?.commit()).toBe(true);
        postReadyWork.resolve();
        hookLoad.release();
        // Dynamic imports can outlive a turn; close only after the real admission waiter parks.
        await admissionParked.promise;
        connectionWork.beginClose();
        // Close retains admitted imports, but must retire parked admission without reopening it.
        await connectionWork.drain();
        expect(sidecarsReady).toHaveBeenCalledTimes(stage === "orphans" ? 0 : 1);
        expect(gatewayStart).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(stage === "orphans" ? 0 : 1);
      } finally {
        admissionSpy.mockRestore();
        suspension?.release();
        postReadyWork.resolve();
        hookLoad.release();
        await runtime.startupSettled;
        await connectionWork.drain();
      }
    },
  );
}
