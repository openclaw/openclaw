import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { RunHeartbeatOnceOptions } from "./types-core.js";
import type { PluginRuntime } from "./types.js";

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("../../infra/heartbeat-runner.js"),
);
const runHeartbeatOnceInternal = createLazyRuntimeMethod(
  loadHeartbeatRunnerRuntime,
  (runtime) => runtime.runHeartbeatOnce,
);

export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    requestHeartbeatNow,
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => {
      // Destructure to forward only the plugin-safe subset; prevent cfg/deps injection at runtime.
      const { reason, agentId, sessionKey, heartbeat } = opts ?? {};
      return runHeartbeatOnceInternal({
        reason,
        agentId,
        sessionKey,
        heartbeat: heartbeat ? { target: heartbeat.target } : undefined,
      });
    },
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
