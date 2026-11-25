import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import { captureSessionEventTarget, createSessionEventEnqueuer } from "./runtime-session-events.js";
import {
  capturePluginSessionGeneration,
  postPluginSessionNotice,
} from "./runtime-session-notice.js";
import { enqueueSystemEventFromSdk } from "./system-events.js";
import type { PluginRuntime } from "./types.js";

/** Creates the plugin runtime system facade with session-event and process helpers. */
export function createRuntimeSystem(
  enqueueForHost: Parameters<typeof createSessionEventEnqueuer>[0],
): PluginRuntime["system"] {
  return {
    captureSessionEventTarget,
    enqueueSessionEvent: createSessionEventEnqueuer(enqueueForHost),
    enqueueSystemEvent: enqueueSystemEventFromSdk,
    captureSessionGeneration: capturePluginSessionGeneration,
    postSessionNotice: postPluginSessionNotice,
    async runCommandWithTimeout(...args) {
      const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
      const { runCommandWithTimeout } = await import("../../process/exec.js");
      assertCurrent?.();
      return await runCommandWithTimeout(...args);
    },
    formatNativeDependencyHint,
  };
}
