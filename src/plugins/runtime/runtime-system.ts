import { runCommandWithTimeout } from "../../process/exec.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import { captureSessionEventTarget, enqueueSessionEvent } from "./runtime-session-events.js";
import { enqueueSystemEventFromSdk } from "./system-events.js";
import type { PluginRuntime } from "./types.js";

/** Creates the plugin runtime system facade with session-event and process helpers. */
export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    captureSessionEventTarget,
    enqueueSessionEvent,
    enqueueSystemEvent: enqueueSystemEventFromSdk,
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
