import { randomUUID } from "node:crypto";
import { createDefaultDeps, type CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import type { CronJob } from "../cron/types.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { HookAgentDispatchPayload } from "./hooks.js";

type IngressLogger = {
  warn: (message: string) => void;
};

const defaultIngressDeps = createDefaultDeps();

export type IngressAgentDispatchResult = {
  runId: string;
  completion: Promise<void>;
};

export function dispatchWakeIngressAction(
  value: { text: string; mode: "now" | "next-heartbeat" },
  options?: { sessionKey?: string; heartbeatReason?: string },
): void {
  const sessionKey = options?.sessionKey ?? resolveMainSessionKeyFromConfig();
  enqueueSystemEvent(value.text, { sessionKey });
  if (value.mode === "now") {
    requestHeartbeatNow({ reason: options?.heartbeatReason ?? "hook:wake" });
  }
}

export function dispatchAgentIngressAction(
  value: HookAgentDispatchPayload,
  options: {
    deps?: CliDeps;
    logger: IngressLogger;
    loadConfig?: typeof loadConfig;
    mainSessionKey?: string;
    jobIdFactory?: () => string;
    runIdFactory?: () => string;
  },
): IngressAgentDispatchResult {
  const jobId = (options.jobIdFactory ?? randomUUID)();
  const runId = (options.runIdFactory ?? randomUUID)();
  const now = Date.now();
  const job: CronJob = {
    id: jobId,
    agentId: value.agentId,
    name: value.name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: value.wakeMode,
    payload: {
      kind: "agentTurn",
      message: value.message,
      model: value.model,
      thinking: value.thinking,
      timeoutSeconds: value.timeoutSeconds,
      deliver: value.deliver,
      channel: value.channel,
      to: value.to,
      allowUnsafeExternalContent: value.allowUnsafeExternalContent,
    },
    state: { nextRunAtMs: now },
  };

  const mainSessionKey = options.mainSessionKey ?? resolveMainSessionKeyFromConfig();

  const completion = (async () => {
    try {
      const cfg = (options.loadConfig ?? loadConfig)();
      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps: options.deps ?? defaultIngressDeps,
        job,
        message: value.message,
        sessionKey: value.sessionKey,
        lane: "cron",
        deliveryContract: "shared",
      });
      const summary = result.summary?.trim() || result.error?.trim() || result.status;
      const prefix =
        result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
      if (!result.delivered) {
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      }
    } catch (err) {
      options.logger.warn(`hook agent failed: ${String(err)}`);
      enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
        sessionKey: mainSessionKey,
      });
      if (value.wakeMode === "now") {
        requestHeartbeatNow({ reason: `hook:${jobId}:error` });
      }
    }
  })();

  return { runId, completion };
}
