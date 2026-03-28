import { randomUUID } from "node:crypto";
import { sanitizeInboundSystemTags } from "../../auto-reply/reply/inbound-text.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { type HookAgentDispatchPayload, type HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function resolveHookEventSessionKey(params: { cfg: OpenClawConfig; agentId?: string }): string {
  return params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
}

/**
 * Determines whether a shared hook result should be surfaced as a system
 * event in the hook's resolved main-session destination.
 */
export function shouldAnnounceHookResultToMain(params: {
  value: Pick<HookAgentDispatchPayload, "deliver">;
  result: RunCronAgentTurnResult;
}): boolean {
  const { value, result } = params;

  if (result.status !== "ok") {
    return true;
  }

  if (typeof result.announceToMain === "boolean") {
    return result.announceToMain;
  }

  if (!value.deliver) {
    return false;
  }

  if (result.delivered === true) {
    return false;
  }

  // `deliveryAttempted` is intentionally broader than "an outbound send
  // definitely happened": dispatchCronDelivery also sets it on handled/no-
  // fallback paths (for example stale delivery skips and descendant/interim
  // suppression) specifically to prevent redundant enqueueSystemEvent
  // fallback.
  if (result.deliveryAttempted === true) {
    return false;
  }

  return true;
}

function formatHookPrefix(name: string | undefined, status: string): string {
  const raw = name?.trim() || "Hook";
  const lower = raw.toLowerCase();
  const base = lower === "hook" || lower.startsWith("hook ") ? raw : `Hook ${raw}`;
  return status === "ok" ? base : `${base} (${status})`;
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
    enqueueSystemEvent(value.text, { sessionKey, trusted: false });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = randomUUID();
    const now = Date.now();
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
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
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    let hookEventSessionKey: string | undefined;
    void (async () => {
      try {
        const cfg = getRuntimeConfig();
        hookEventSessionKey = resolveHookEventSessionKey({
          cfg,
          agentId: value.agentId,
        });
        const { runCronIsolatedAgentTurn } = await import("../../cron/isolated-agent.js");
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary =
          normalizeOptionalString(result.summary) ||
          normalizeOptionalString(result.error) ||
          result.status;
        const prefix = formatHookPrefix(safeName, result.status);
        if (shouldAnnounceHookResultToMain({ value, result })) {
          const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();

          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: eventSessionKey,
            trusted: false,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`${formatHookPrefix(safeName, "error")}: ${String(err)}`, {
          sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig(),
          trusted: false,
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
