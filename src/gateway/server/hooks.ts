import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent.js";
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

/**
 * Determines whether a shared hook result should be surfaced as a system
 * event in the main session.  This replaces the previous `!result.delivered`
 * gate with a richer compatibility bridge that respects explicit policy,
 * `deliver:false` hooks, and the already-existing `deliveryAttempted` field.
 */
export function shouldAnnounceHookResultToMain(params: {
  value: HookAgentDispatchPayload;
  result: RunCronAgentTurnResult;
}): boolean {
  const { value, result } = params;

  // Always surface real run-level errors, including non-throw status:"error".
  if (result.status !== "ok") {
    return true;
  }

  // Explicit result-level policy wins when present.
  if (typeof result.announceToMain === "boolean") {
    return result.announceToMain;
  }

  // Compatibility bridge for existing hook configurations:
  // - deliver:false hooks should stay silent on success
  if (value.deliver === false) {
    return false;
  }
  // - already-delivered hooks should not duplicate into main
  if (result.delivered === true) {
    return false;
  }
  // - delivery-attempted hooks should not fallback into main
  if (result.deliveryAttempted === true) {
    return false;
  }

  return true;
}

/**
 * Builds the prefix label for hook fallback system events.
 * Avoids the "Hook Hook" symptom when the hook name defaults to "Hook".
 */
function formatHookPrefix(name: string | undefined, status: string): string {
  const raw = name?.trim() || "Hook";
  const base = raw.toLowerCase() === "hook" ? "Hook" : `Hook ${raw}`;
  return status === "ok" ? base : `${base} (${status})`;
}

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
        externalContentSource: value.externalContentSource,
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
          deliveryContract: "shared",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix = formatHookPrefix(value.name, result.status);
        if (shouldAnnounceHookResultToMain({ value, result })) {
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`${formatHookPrefix(value.name, "error")}: ${String(err)}`, {
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
