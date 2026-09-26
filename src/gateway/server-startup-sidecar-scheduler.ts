import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type Awaitable<T> = T | Promise<T>;

export type GatewayPostReadySidecarHandle = {
  stop: () => Awaitable<void>;
  preparePluginReload?: (params: {
    previousRegistry: PluginRegistry;
    nextRegistry: PluginRegistry;
    changedPluginIds: ReadonlySet<string>;
    nextConfig: OpenClawConfig;
  }) => { drain: () => Promise<void>; resume: (config: OpenClawConfig) => Awaitable<void> };
};

export function schedulePostReadySidecarTask(params: {
  startupTrace?: GatewayStartupTrace;
  name: string;
  log: { warn: (msg: string) => void };
  run: (isStopped: () => boolean, signal: AbortSignal) => Awaitable<void>;
  stop?: () => Awaitable<void>;
  waitForPostReadyWork?: () => Promise<void>;
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  const abortController = new AbortController();
  // Closing retires producers before received work permits sidecar teardown.
  const isStopped = () => abortController.signal.aborted || params.shouldRun?.() === false;
  const handle = setImmediate(() => {
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (isStopped()) {
        return;
      }
      // Suspension can defer admission, so eligibility must be checked again inside it.
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        if (isStopped()) {
          return;
        }
        await measureStartup(params.startupTrace, params.name, () =>
          params.run(isStopped, abortController.signal),
        );
      }, `startup:${params.name}`);
    })().catch((err: unknown) => {
      params.log.warn(`${params.name} failed after gateway ready: ${String(err)}`);
    });
  });
  handle.unref?.();
  return {
    stop: async () => {
      // Sidecars get both a synchronous stopped predicate and an AbortSignal so
      // lazy imports and long-running watchers can cooperate with shutdown.
      abortController.abort();
      clearImmediate(handle);
      await params.stop?.();
    },
  };
}

export function scheduleGatewayGenerationTimer(params: {
  scheduler: GatewayScheduler;
  delayMs: number;
  origin: string;
  run: (isStopped: () => boolean) => Awaitable<void>;
  onError: (err: unknown) => void;
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  const { scheduler } = params;
  const controller = new AbortController();
  const isStopped = () => controller.signal.aborted || params.shouldRun?.() === false;
  const job = scheduler.schedule({
    id: params.origin,
    delayMs: params.delayMs,
    run: () => {
      if (isStopped()) {
        return undefined;
      }
      return runWithGatewayIndependentRootWorkAdmission(
        async () => {
          if (isStopped()) {
            return;
          }
          await params.run(isStopped);
        },
        params.origin,
        controller.signal,
      ).catch((err: unknown) => {
        if (!controller.signal.aborted) {
          params.onError(err);
        }
      });
    },
  });
  return {
    stop: () => {
      controller.abort();
      return job.stop();
    },
  };
}
