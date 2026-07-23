// Runtime system helpers expose host system operations to activated plugin runtimes.
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
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

/** Creates the plugin runtime system facade with heartbeat/event/process helpers. */
export function createRuntimeSystem(): PluginRuntime["system"] {
  const requestHeartbeatNow: PluginRuntime["system"]["requestHeartbeatNow"] = (opts) =>
    requestHeartbeat({
      source: opts?.source ?? "other",
      intent: opts?.intent ?? "immediate",
      reason: opts?.reason,
      coalesceMs: opts?.coalesceMs,
      agentId: opts?.agentId,
      sessionKey: opts?.sessionKey,
      heartbeat: opts?.heartbeat,
    });

  return {
    enqueueSystemEvent,
    requestHeartbeat,
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
    // Host-hook / plugin runtime commands default to process-tree termination so
    // timeout and abort cleanup reaps descendants, not only the direct child.
    // Callers may still pass killProcessTree: false to opt out explicitly.
    runCommandWithTimeout: ((argv, optionsOrTimeout) => {
      if (typeof optionsOrTimeout === "number") {
        return runCommandWithTimeout(argv, {
          timeoutMs: optionsOrTimeout,
          killProcessTree: true,
        });
      }
      return runCommandWithTimeout(argv, {
        ...optionsOrTimeout,
        killProcessTree: optionsOrTimeout.killProcessTree ?? true,
      });
    }) as typeof runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
