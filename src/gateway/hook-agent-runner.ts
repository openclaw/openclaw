// Shared agent-run execution for immediate and queued Gateway hooks.
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeInboundSystemTags } from "../auto-reply/reply/inbound-text.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../cron/isolated-agent/run.types.js";
import type { CronJob, CronSessionTarget } from "../cron/types.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { HookAgentDispatchPayload } from "./hooks.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type HookAgentRunCompletion = {
  status: RunCronAgentTurnResult["status"] | "error";
  summary: string;
  error?: string;
};

export type HookAgentRunIdentity = {
  jobId: string;
  runId: string;
};

function resolveHookEventSessionKey(params: { cfg: OpenClawConfig; agentId?: string }): string {
  return params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
}

function shouldAnnounceHookRunResult(params: {
  deliver: boolean;
  result: RunCronAgentTurnResult;
}): boolean {
  if (params.result.status !== "ok") {
    return true;
  }
  return (
    params.deliver && params.result.delivered !== true && params.result.deliveryAttempted !== true
  );
}

function resolveHookRunSummary(result: RunCronAgentTurnResult): string {
  const diagnosticsSummary =
    result.status !== "ok" ? normalizeOptionalString(result.diagnostics?.summary) : undefined;
  return (
    diagnosticsSummary ||
    normalizeOptionalString(result.summary) ||
    normalizeOptionalString(result.error) ||
    result.status
  );
}

function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function formatHookRunWarningConsoleMessage(params: {
  status: string;
  model: string | undefined;
  summary: string;
}): string {
  const parts = [
    "hook agent run returned non-ok status",
    `status=${sanitizeHookConsoleValue(params.status) ?? "unknown"}`,
  ];
  const model = sanitizeHookConsoleValue(params.model);
  if (model) {
    parts.push(`model=${model}`);
  }
  const summary = sanitizeHookConsoleValue(params.summary);
  if (summary) {
    parts.push(`summary=${summary}`);
  }
  return parts.join(" ");
}

function buildHookCronJob(params: {
  value: HookAgentDispatchPayload;
  safeName: string;
  jobId: string;
  nowMs: number;
  sessionTarget: CronSessionTarget;
}): CronJob {
  const delivery = params.value.deliver
    ? {
        mode: "announce" as const,
        channel: params.value.channel,
        to: params.value.to,
      }
    : { mode: "none" as const };
  return {
    id: params.jobId,
    agentId: params.value.agentId,
    name: params.safeName,
    enabled: true,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "at", at: resolveTimestampMsToIsoString(params.nowMs) },
    sessionTarget: params.sessionTarget,
    wakeMode: params.value.wakeMode,
    payload: {
      kind: "agentTurn",
      message: params.value.message,
      model: params.value.model,
      thinking: params.value.thinking,
      timeoutSeconds: params.value.timeoutSeconds,
      allowUnsafeExternalContent: params.value.allowUnsafeExternalContent,
      externalContentSource: params.value.externalContentSource,
    },
    delivery,
    state: { nextRunAtMs: params.nowMs },
  };
}

export async function runHookAgentDispatch(params: {
  deps: CliDeps;
  logHooks: SubsystemLogger;
  identity: HookAgentRunIdentity;
  value: HookAgentDispatchPayload;
  sessionTarget?: CronSessionTarget;
}): Promise<HookAgentRunCompletion> {
  const sessionKey = params.value.sessionKey;
  const safeName = sanitizeInboundSystemTags(params.value.name);
  const nowMs = resolveDateTimestampMs(Date.now());
  const sessionTarget = params.sessionTarget ?? "isolated";
  const job = buildHookCronJob({
    value: params.value,
    safeName,
    jobId: params.identity.jobId,
    nowMs,
    sessionTarget,
  });

  let hookEventSessionKey: string | undefined;
  try {
    // Agent hooks run after the HTTP response path has returned, so failure
    // handling must record a system event instead of throwing to the caller.
    const cfg = getRuntimeConfig();
    hookEventSessionKey = resolveHookEventSessionKey({
      cfg,
      agentId: params.value.agentId,
    });
    const { runCronIsolatedAgentTurn } = await import("../cron/isolated-agent.js");
    const result = await runCronIsolatedAgentTurn({
      cfg,
      deps: params.deps,
      job,
      message: params.value.message,
      sessionKey,
      lane: "cron",
    });
    const summary = resolveHookRunSummary(result);
    const prefix =
      result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
    const shouldAnnounce = shouldAnnounceHookRunResult({
      deliver: params.value.deliver,
      result,
    });
    if (result.status !== "ok") {
      params.logHooks.warn("hook agent run returned non-ok status", {
        sourcePath: params.value.sourcePath,
        name: safeName,
        runId: params.identity.runId,
        jobId: params.identity.jobId,
        agentId: params.value.agentId,
        sessionKey,
        sessionTarget,
        status: result.status,
        model: params.value.model,
        summary,
        consoleMessage: formatHookRunWarningConsoleMessage({
          status: result.status,
          model: params.value.model,
          summary,
        }),
      });
    }
    if (shouldAnnounce) {
      const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
      enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
        sessionKey: eventSessionKey,
      });
      if (params.value.wakeMode === "now") {
        requestHeartbeat({
          source: "hook",
          intent: "immediate",
          reason: `hook:${params.identity.jobId}`,
        });
      }
    } else if (result.status === "ok" && !params.value.deliver) {
      params.logHooks.info("hook agent run completed without announcement", {
        sourcePath: params.value.sourcePath,
        name: safeName,
        runId: params.identity.runId,
        jobId: params.identity.jobId,
        agentId: params.value.agentId,
        sessionKey,
        sessionTarget,
        completedAt: new Date().toISOString(),
      });
    }
    return {
      status: result.status,
      summary,
      ...(result.status === "ok"
        ? {}
        : { error: normalizeOptionalString(result.error) ?? summary }),
    };
  } catch (err) {
    const error = String(err);
    params.logHooks.warn(`hook agent failed: ${error}`);
    enqueueSystemEvent(`Hook ${safeName} (error): ${error}`, {
      sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig(),
    });
    if (params.value.wakeMode === "now") {
      requestHeartbeat({
        source: "hook",
        intent: "immediate",
        reason: `hook:${params.identity.jobId}:error`,
      });
    }
    return { status: "error", summary: error, error };
  }
}
