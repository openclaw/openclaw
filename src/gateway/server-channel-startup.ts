import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { runOutsidePluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOutsideOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";

/** Channel tasks outlive their caller's authority, work scope, lease, and generation. */
export function runChannelAccountStartup<T>(start: () => T): T {
  return withoutGatewayToolCallerIdentity(() =>
    runOutsideOperatorToolGatewayAuthority(() =>
      runOutsidePluginLifecycleLease(() =>
        runOutsideGatewayRootWorkAdmission(() =>
          runOutsidePluginRuntimeGenerationScope(() => runOutsideAsyncWorkScope(start)),
        ),
      ),
    ),
  );
}

export function waitForChannelStartupHandoff(): Promise<void> {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

export async function runChannelAccountMonitor<T>(
  registry: PluginRegistry,
  pluginId: string | null | undefined,
  start: () => Promise<T>,
): Promise<T> {
  const record = registry.plugins.find((entry) => entry.id === pluginId);
  const instance = record && getPluginInstance(record);
  if (instance && !instance.acceptingCalls) {
    throw new PluginInstanceUnavailableError(instance.pluginId);
  }
  // Host-owned monitor custody drains after stop and cannot block replacement admission.
  const consumer = instance?.retainConsumer(undefined, undefined, "custody");
  try {
    return await (consumer ? consumer.run(start) : start());
  } finally {
    consumer?.release();
  }
}

export async function waitForDeferredAccountStart(
  deferred: Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  const aborted = createDeferredCore();
  const onAbort = () => aborted.resolve();
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([deferred, aborted.promise]);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}
