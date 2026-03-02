import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import type { CronJob } from "../../cron/types.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createOAuthCallbackHandler } from "../oauth-callback-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayOAuthCallbackHandler(params: {
  deps: CliDeps;
  logOAuth: SubsystemLogger;
}) {
  const { deps, logOAuth } = params;

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: import("../hooks.js").HookMessageChannel;
  }) => {
    const sessionKey = value.sessionKey.trim() ? value.sessionKey.trim() : `oauth:${randomUUID()}`;
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
        deliver: value.deliver,
        channel: value.channel,
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
        const prefix = result.status === "ok" ? `Google OAuth` : `Google OAuth (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), { sessionKey: mainSessionKey });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `oauth:${jobId}` });
        }
      } catch (err) {
        logOAuth.warn(`OAuth hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Google OAuth (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `oauth:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createOAuthCallbackHandler({ logOAuth, dispatchAgentHook });
}
