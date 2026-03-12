import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizeHookDispatchSessionKey,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
} from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: value.agentId,
    });
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();

    // Route through the cron normalization pipeline so legacy flat fields
    // (deliver, channel, to) are promoted into a proper CronDelivery and
    // accountId is preserved end-to-end.
    const jobCreate = normalizeCronJobCreate({
      agentId: value.agentId,
      name: value.name,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      // Hook sessions may be reused across runs (explicit or default sessionKey),
      // so never auto-delete the session after delivery (#43866).
      deleteAfterRun: false,
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
      ...(value.accountId ? { delivery: { accountId: value.accountId } } : {}),
    });
    if (!jobCreate) {
      logHooks.warn("hook agent: normalizeCronJobCreate returned null");
      return { ok: false as const, error: "internal: failed to normalize hook payload" };
    }

    const job: CronJob = {
      ...jobCreate,
      id: jobId,
      createdAtMs: now,
      updatedAtMs: now,
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
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
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
    dispatchWakeHook,
  });
}
