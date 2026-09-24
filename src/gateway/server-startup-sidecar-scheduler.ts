import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  delayMs: number;
  origin: string;
  run: (isStopped: () => boolean) => Awaitable<void>;
  onError: (err: unknown) => void;
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped || params.shouldRun?.() === false;
  timer = setTimeout(() => {
    timer = undefined;
    if (isStopped()) {
      return;
    }
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (isStopped()) {
        return;
      }
      await params.run(isStopped);
    }, params.origin).catch((err: unknown) => {
      // Closing must not hide errors from callbacks already admitted before it.
      if (!stopped) {
        params.onError(err);
      }
    });
  }, params.delayMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
