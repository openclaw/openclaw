import { runHeartbeatOnce as runHeartbeatOnceInternal } from "../../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { RunHeartbeatOnceOptions } from "./types-core.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    requestHeartbeatNow,
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => runHeartbeatOnceInternal(opts ?? {}),
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
