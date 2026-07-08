// Gateway hook server wiring translates external hook requests into wake events or isolated agent runs.
import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.types.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { runHookAgentDispatch } from "../hook-agent-runner.js";
import type { HookQueueRuntime } from "../hook-queue-runtime.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

/**
 * Gateway hook HTTP handler factory.
 *
 * Hooks can either enqueue wake events or spawn agent turns; both paths
 * sanitize external input before it reaches logs or system-event text.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/** Creates the HTTP handler used by gateway hook endpoints. */
export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
  hookQueueRuntime: HookQueueRuntime;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks, hookQueueRuntime } =
    params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, {
      sessionKey,
    });
    if (value.mode === "now") {
      requestHeartbeat({ source: "hook", intent: "immediate", reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const jobId = randomUUID();
    const runId = randomUUID();

    void (async () => {
      await runHookAgentDispatch({
        deps,
        logHooks,
        identity: { jobId, runId },
        value,
      });
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    enqueueAgentHook: hookQueueRuntime.enqueueAgentHook,
    dispatchWakeHook,
  });
}
