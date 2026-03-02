import { randomUUID } from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { PluginRuntime } from "./types.js";

async function deliverToSession(
  sessionKey: string,
  message: string,
  opts?: { timeoutMs?: number; deliver?: boolean; channel?: string; to?: string },
): Promise<void> {
  await callGateway({
    method: "agent",
    params: {
      sessionKey,
      idempotencyKey: randomUUID(),
      message,
      // deliver defaults to true — run agent and route reply back to its channel
      deliver: opts?.deliver ?? true,
      // channel + to allow explicit routing, overriding session's last-known channel
      ...(opts?.channel ? { channel: opts.channel } : {}),
      ...(opts?.to ? { to: opts.to } : {}),
    },
    timeoutMs: opts?.timeoutMs ?? 10_000,
  });
}

export function createRuntimeSystem(): PluginRuntime["system"] {
  return {
    enqueueSystemEvent,
    requestHeartbeatNow,
    runCommandWithTimeout,
    formatNativeDependencyHint,
    deliverToSession,
  };
}
