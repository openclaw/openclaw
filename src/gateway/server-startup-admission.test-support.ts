import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof startGatewayPostAttachRuntime>[1]>;

export function registerGatewayStartupAdmissionTests(params: {
  start: typeof startGatewayPostAttachRuntime;
  createParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
  createRuntimeDeps: (overrides?: Partial<PostAttachRuntimeDeps>) => PostAttachRuntimeDeps;
}): void {
  it.each(["sentinel", "gateway_start"] as const)(
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
      const hookRunner = createHookRunner(pluginRegistry);
      const postReadyWork = createDeferred();
      const hookLoadStarted = createDeferred();
      const releaseHookLoad = createDeferred();
      const connectionWork = new GatewayConnectionWork();
      const refresh = vi.fn(async () => null);
      const sidecarsReady = vi.fn();
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
            createHookRunner: async () => {
              hookLoadStarted.resolve();
              if (stage === "gateway_start") {
                await releaseHookLoad.promise;
                return hookRunner;
              }
              return createHookRunner(createEmptyPluginRegistry());
            },
          }),
        ),
      );
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
      let closing: Promise<void> | undefined;
      const admissionParked = createDeferred();
      const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation((run, origin, signal) => {
          const work = runWithAdmission(run, origin, signal);
          if (
            origin === (stage === "sentinel" ? "startup:update-sentinel" : "hooks:gateway-start")
          ) {
            admissionParked.resolve();
          }
          return work;
        });
      try {
        expect(sidecarsReady).toHaveBeenCalledOnce();
        if (stage === "gateway_start") {
          postReadyWork.resolve();
          await hookLoadStarted.promise;
        }
        suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension?.commit()).toBe(true);
        postReadyWork.resolve();
        await hookLoadStarted.promise;
        releaseHookLoad.resolve();
        // Dynamic imports can outlive a turn; close only after the real admission waiter parks.
        await admissionParked.promise;
        let drained = false;
        connectionWork.beginClose();
        closing = connectionWork.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(drained, "startup admission retires without reopening suspension").toBe(true);
        suspension?.release();
        await closing;
        expect(gatewayStart).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(stage === "sentinel" ? 0 : 1);
      } finally {
        admissionSpy.mockRestore();
        suspension?.release();
        postReadyWork.resolve();
        releaseHookLoad.resolve();
        await runtime.startupSettled;
        await connectionWork.drain();
        await closing;
      }
    },
  );
}
