import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isSessionKeyAllowedByPrefix,
  normalizeHookDispatchSessionKey,
  resolveHookRuntimeSessionKey,
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
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const rawTarget = value.sessionTarget ?? "isolated";

    // "current" has no meaning for hooks (no active conversation context) —
    // falls back to default session resolution (mapping sessionKey if configured, otherwise fresh UUID).
    const resolvedTarget = rawTarget === "current" ? "isolated" : rawTarget;
    if (rawTarget === "current") {
      logHooks.info(
        `hook "${value.name}": sessionTarget "current" has no effect in hook context — using default session resolution`,
      );
    }

    // Defense-in-depth: validate "session:<id>" and "main" targets against prefix policy.
    // Primary enforcement is in server-http.ts, but guard here in case dispatchAgentHook
    // is reached from a future code path that skips the HTTP-layer checks.
    // Note: allowRequestSessionKey is intentionally NOT checked here — this function
    // handles both request-sourced and mapping-sourced dispatches, and mappings are
    // trusted operator config that should not be gated by request policy.
    // On policy rejection, downgrade to "isolated" (fresh session) and log a warning.
    let policyTarget = resolvedTarget;
    if (resolvedTarget.startsWith("session:") || resolvedTarget === "main") {
      const hooksConfig = getHooksConfig();
      if (hooksConfig) {
        const keyToCheck = resolveHookRuntimeSessionKey({
          sessionKey:
            resolvedTarget === "main" ? mainSessionKey : resolvedTarget.slice("session:".length),
          targetAgentId: value.agentId,
          defaultAgentId: hooksConfig.agentPolicy.defaultAgentId,
          cfg: loadConfig(),
        });
        const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
        if (allowedPrefixes && !isSessionKeyAllowedByPrefix(keyToCheck, allowedPrefixes)) {
          logHooks.warn(
            `hook "${value.name}": sessionTarget "${resolvedTarget}" rejected by prefix policy; falling back to isolated`,
          );
          policyTarget = "isolated";
        }
      }
    }

    // Resolve sessionKey based on sessionTarget:
    // "main" → use canonical main session key (runs in main session via cron runner)
    // "session:<id>" → use the explicit session id
    // "isolated" / default → use mapping sessionKey or generate unique key
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey:
        policyTarget === "main"
          ? mainSessionKey
          : policyTarget.startsWith("session:")
            ? policyTarget.slice("session:".length)
            : value.sessionKey,
      targetAgentId: value.agentId,
    });
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
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: policyTarget,
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
