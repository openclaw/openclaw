import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { createDeferredWorkTracker } from "../shared/async-work-scope.test-support.js";
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
  it.each(["loading", "hydrating"] as const)(
    "keeps input closed while registry %s is pending and the Gateway closes",
    async (stage) => {
      const tracked: Promise<unknown>[] = [];
      const lifetime = new AbortController();
      const registryLoad = createStartupGate();
      const registryHydration = createStartupGate();
      const unlockStartupMethods = vi.fn();
      const activateSubagentRegistry = vi.fn(registryHydration.run);
      await installGatewaySubagentModuleLoad(
        registryLoad.run,
        activateSubagentRegistry,
        params.startupModuleRestorers,
      );
      const runtime = await params.start(
        {
          ...params.createParams(),
          sidecarStartup: "defer",
          trackStartupWork: (run) => {
            const work = run(lifetime.signal);
            tracked.push(work);
            return work;
          },
          isClosing: () => lifetime.signal.aborted,
          unlockStartupMethods,
        },
        params.createRuntimeDeps(),
      );

      try {
        await runtime.startupSettled;
        await registryLoad.entered;
        if (stage === "hydrating") {
          registryLoad.release();
          await registryHydration.entered;
        } else {
          expect(activateSubagentRegistry).not.toHaveBeenCalled();
        }
        expect(unlockStartupMethods).not.toHaveBeenCalled();
        lifetime.abort();
        registryLoad.release();
        registryHydration.release();
        await Promise.allSettled(tracked);

        expect(activateSubagentRegistry).toHaveBeenCalledTimes(Number(stage === "hydrating"));
        expect(unlockStartupMethods).not.toHaveBeenCalled();
      } finally {
        lifetime.abort();
        registryLoad.release();
        registryHydration.release();
        await Promise.allSettled(tracked);
      }
    },
  );

  it.each(["session-resume", "gateway_start"] as const)(
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
      const hookLoad = createStartupGate();
      const connectionWork = new GatewayConnectionWork();
      const refreshStarted = createDeferred();
      const refresh = vi.fn(async () => {
        refreshStarted.resolve();
        return null;
      });
      const sidecarsReady = vi.fn();
      // Session resumption and the hook retain their own startup admission.
      if (stage === "session-resume") {
        pluginRegistry.typedHooks.length = 0;
        hookLoad.release();
      }
      await installGatewayHookModuleLoad(hookLoad.run, params.startupModuleRestorers);
      const trackStartupWork = createDeferredWorkTracker(connectionWork);
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> =
        stage === "session-resume" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspension) {
        expect(suspension.commit()).toBe(true);
      }
      const admissionParked = createDeferred();
      const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation((run, origin, signal) => {
          const work = runWithAdmission(run, origin, signal);
          if (
            origin ===
            (stage === "session-resume" ? "startup:session-resume" : "hooks:gateway-start")
          ) {
            admissionParked.resolve();
          }
          return work;
        });
      const runtime = await trackStartupWork(() =>
        params.start(
          params.createParams({
            pluginRegistry,
            sidecarStartup: "defer",
            isClosing: () => connectionWork.isClosing,
            trackStartupWork,
            onSidecarsReady: sidecarsReady,
          }),
          params.createRuntimeDeps({
            refreshLatestUpdateRestartSentinel: refresh,
          }),
        ),
      );
      try {
        await runtime.startupSettled;
        if (stage === "gateway_start") {
          await hookLoad.entered;
          await refreshStarted.promise;
          suspension = tryBeginGatewaySuspendAdmission(() => {});
          expect(suspension?.commit()).toBe(true);
        }
        hookLoad.release();
        // Dynamic imports can outlive a turn; close only after the real admission waiter parks.
        await admissionParked.promise;
        connectionWork.beginClose();
        // Close retains admitted imports, but must retire parked admission without reopening it.
        await connectionWork.drain();
        expect(sidecarsReady).toHaveBeenCalledOnce();
        expect(gatewayStart).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(stage === "session-resume" ? 0 : 1);
      } finally {
        admissionSpy.mockRestore();
        suspension?.release();
        hookLoad.release();
        await runtime.startupSettled;
        await connectionWork.drain();
      }
    },
  );
}
