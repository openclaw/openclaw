import { createHmac, randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import type { CronJob } from "../../cron/types.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createHooksRequestHandler } from "../server-http.js";

const RESPONSE_CALLBACK_TIMEOUT_MS = 10_000;

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

async function postResponseCallback(params: {
  responseUrl: string;
  responseSecret?: string;
  body: Record<string, unknown>;
  logHooks: SubsystemLogger;
  label: string;
}): Promise<void> {
  const { responseUrl, responseSecret, body, logHooks, label } = params;
  try {
    const jsonBody = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (responseSecret) {
      headers["X-OpenClaw-Signature"] = `sha256=${signPayload(jsonBody, responseSecret)}`;
    }
    const result = await fetchWithSsrFGuard({
      url: responseUrl,
      init: { method: "POST", headers, body: jsonBody },
      timeoutMs: RESPONSE_CALLBACK_TIMEOUT_MS,
      auditContext: "hook-response-callback",
    });
    await result.release();
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      logHooks.warn(`${label}: blocked by SSRF policy`);
    } else {
      const errMsg =
        err instanceof Error && err.name === "AbortError" ? "timeout" : "callback failed";
      logHooks.warn(`${label}: ${errMsg}`);
    }
  }
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
    responseUrl?: string;
    responseSecret?: string;
  }) => {
    const sessionKey = value.sessionKey.trim();
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
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;

        if (value.responseUrl) {
          await postResponseCallback({
            responseUrl: value.responseUrl,
            responseSecret: value.responseSecret,
            body: {
              runId,
              status: result.status,
              summary: result.summary,
              outputText: result.outputText,
              error: result.error,
              sessionKey,
              jobId,
              timestamp: Date.now(),
            },
            logHooks,
            label: "hook responseUrl callback",
          });
        }

        enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);

        if (value.responseUrl) {
          await postResponseCallback({
            responseUrl: value.responseUrl,
            responseSecret: value.responseSecret,
            body: {
              runId,
              status: "error",
              error: "agent turn failed",
              sessionKey,
              jobId,
              timestamp: Date.now(),
            },
            logHooks,
            label: "hook responseUrl error callback",
          });
        }

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
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
