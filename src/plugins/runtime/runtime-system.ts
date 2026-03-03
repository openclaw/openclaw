import type { PluginRuntime } from "./types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatNativeDependencyHint } from "./native-deps.js";

export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    requestHeartbeatNow,
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
