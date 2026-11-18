import { isDebugProxyCaptureEnvEnabled } from "./run-main-policy.js";
import type { createGatewayDispatchStartupTrace } from "./startup-trace.js";

export async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

export async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>,
  ensureDispatcher: boolean,
): Promise<void> {
  // Capture init and coverage warnings no-op unless the
  // debug-proxy env requests capture; importing their sqlite-store graph anyway
  // costs ~100 MB RSS on metadata-only commands such as `plugins list --json`.
  if (isDebugProxyCaptureEnvEnabled()) {
    const [{ initializeDebugProxyCaptureAsync }, { maybeWarnAboutDebugProxyCoverage }] =
      await startupTrace.measure("proxy-imports", () =>
        Promise.all([
          import("../proxy-capture/runtime.js"),
          import("../proxy-capture/coverage.js"),
        ]),
      );
    await initializeDebugProxyCaptureAsync("cli");
    maybeWarnAboutDebugProxyCoverage(undefined, (message) => console.warn(message));
  }
  if (ensureDispatcher) {
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  }
}
