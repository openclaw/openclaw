import { expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../test/helpers/promise.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  registerPluginSnapshotScrub,
  type PluginSnapshotScrubOutcome,
} from "../plugins/plugin-source-snapshot-scrub.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRegistryOwner, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
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
  it("starts registered snapshot scrubs after startup and joins cancellation at shutdown", async () => {
    const postReady = createDeferred();
    const started = createDeferred();
    const completion = createDeferred<PluginSnapshotScrubOutcome>();
    const sidecars: GatewayPostReadySidecarHandle[] = [];
    const startup = params.createParams({
      waitForPostReadyWork: () => postReady.promise,
      onGatewayLifetimeSidecars: (...entries) => sidecars.push(...entries),
    });
    setActivePluginRegistry(startup.pluginRegistry);
    const owner = createPluginRegistryOwner(startup.pluginRegistry);
    startup.sourceSnapshotScrubs = owner.sourceSnapshotScrubs;
    const start = vi.fn(() => {
      started.resolve();
      return completion.promise;
    });
    const cancel = vi.fn(async () => {
      completion.resolve({ status: "cancelled" });
      await completion.promise;
    });
    const record = createPluginRecord({ id: "startup-snapshot-scrub" });
    startup.pluginRegistry.plugins.push(record);
    const instance = new PluginInstance(record.id, {
      record,
      registry: startup.pluginRegistry,
    });
    const remove = registerPluginSnapshotScrub(instance, start, cancel);
    try {
      const runtime = await params.start(startup, params.createRuntimeDeps());
      await runtime.startupSettled;
      const sidecar = sidecars.find((entry) => entry.name === "sidecars.plugin-source-scrub");
      expect(sidecar).toBeDefined();
      await nextEventLoopTurn();
      expect(start).not.toHaveBeenCalled();
      postReady.resolve();
      await started.promise;
      expect(start).toHaveBeenCalledOnce();
      await params.stopSidecar(sidecar!);
      expect(cancel).toHaveBeenCalledOnce();
      await expect(completion.promise).resolves.toEqual({ status: "cancelled" });
    } finally {
      postReady.resolve();
      completion.resolve({ status: "cancelled" });
      remove();
      await owner.close();
    }
  });

  it("keeps ignored deferred sidecar failure handled for direct callers", async () => {
    const startupError = new Error("deferred sidecar startup failed");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const startup = params.createParams({
        sidecarStartup: "defer",
        refreshChatMetadata: async () => {
          throw startupError;
        },
      });
      const runtime = await params.start(startup, params.createRuntimeDeps());

      await vi.waitFor(
        () => {
          expect(startup.log.warn).toHaveBeenCalledWith(
            `gateway sidecars failed to start: ${String(startupError)}`,
          );
        },
        { interval: 1 },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
      await expect(runtime.startupSettled).rejects.toBe(startupError);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("keeps channel and external input closed until retained inputs have acquired queue custody", async () => {
    const resume = createStartupGate();
    const unlocked = createDeferred();
    const tracked: Promise<unknown>[] = [];
    const lifetime = new AbortController();
    const owner = await import("./session-restart-resume.js");
    const resumeSpy = vi.spyOn(owner, "resumeMarkedSessions").mockImplementation(resume.run);
    const unlockStartupMethods = vi.fn(() => unlocked.resolve());
    const onChannelsStarted = vi.fn();
    try {
      const runtime = await params.start(
        params.createParams({
          sidecarStartup: "defer",
          trackStartupWork: (run) => {
            const work = run(lifetime.signal);
            tracked.push(work);
            return work;
          },
          isClosing: () => lifetime.signal.aborted,
          unlockStartupMethods,
          onChannelsStarted,
        }),
        params.createRuntimeDeps(),
      );
      await runtime.startupSettled;
      await resume.entered;
      expect(unlockStartupMethods).not.toHaveBeenCalled();
      expect(onChannelsStarted).not.toHaveBeenCalled();
      resume.release();
      await unlocked.promise;
      expect(unlockStartupMethods).toHaveBeenCalledOnce();
      expect(onChannelsStarted).toHaveBeenCalledOnce();
    } finally {
      lifetime.abort();
      resume.release();
      await Promise.allSettled(tracked);
      resumeSpy.mockRestore();
    }
  });

  it("opens external input after failed restart discovery", async () => {
    const tracked: Promise<unknown>[] = [];
    const lifetime = new AbortController();
    const owner = await import("./session-restart-resume.js");
    const resumeSpy = vi
      .spyOn(owner, "resumeMarkedSessions")
      .mockRejectedValueOnce(new Error("fixture store unavailable"));
    const unlockStartupMethods = vi.fn();
    const onChannelsStarted = vi.fn();
    const startup = params.createParams({
      sidecarStartup: "defer",
      trackStartupWork: (run) => {
        const work = run(lifetime.signal);
        tracked.push(work);
        return work;
      },
      isClosing: () => lifetime.signal.aborted,
      unlockStartupMethods,
      onChannelsStarted,
    });
    try {
      const runtime = await params.start(startup, params.createRuntimeDeps());
      await runtime.startupSettled;
      await Promise.allSettled(tracked);
      expect(unlockStartupMethods).toHaveBeenCalledOnce();
      expect(onChannelsStarted).toHaveBeenCalledOnce();
      expect(startup.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Restart resume discovery failed"),
      );
    } finally {
      lifetime.abort();
      await Promise.allSettled(tracked);
      resumeSpy.mockRestore();
    }
  });

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
