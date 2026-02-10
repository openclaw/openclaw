import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import type { CronJob } from "../../cron/types.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WebhooksConfigResolved } from "../webhooks-http.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createWebhooksRequestHandler } from "../webhooks-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayWebhooksRequestHandler(params: {
  deps: CliDeps;
  getWebhooksConfig: () => WebhooksConfigResolved | null;
  bindHost: string;
  port: number;
  logWebhooks: SubsystemLogger;
}) {
  const { deps, getWebhooksConfig, bindHost, port, logWebhooks } = params;

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: import("../hooks.js").HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => {
    const sessionKey = value.sessionKey.trim()
      ? value.sessionKey.trim()
      : `webhook:${randomUUID()}`;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
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

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok"
            ? `Webhook ${value.name}`
            : `Webhook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `webhook:${jobId}` });
        }
      } catch (err) {
        logWebhooks.warn(`webhook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Webhook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `webhook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createWebhooksRequestHandler({
    getWebhooksConfig,
    bindHost,
    port,
    logWebhooks,
    dispatchAgentHook,
  });
}
