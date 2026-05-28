import crypto from "node:crypto";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
} from "../../acp/policy.js";
import { formatAcpErrorChain } from "../../acp/runtime/errors.js";
import { listAgentIds, resolveAgentConfig, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSourceDeliveryPlan,
  resolveSourceDeliveryOutcome,
  type SourceDeliveryPlan,
} from "../../infra/outbound/source-delivery-plan.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveCronDeliveryPlan, type CronDeliveryPlan } from "../delivery-plan.js";
import { normalizeOptionalAgentId } from "../service/normalize.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import { resolveCronDeliveryBestEffort, dispatchCronDelivery } from "./run-delivery.runtime.js";
import { resolveDeliveryTarget } from "./run-delivery.runtime.js";
import { pickSummaryFromOutput } from "./helpers.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronStyleNow } from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

const ACP_OUTPUT_LIMIT = 120_000;

type CronAcpPayload = Extract<CronJob["payload"], { kind: "acpTurn" }>;

function resolveCronAcpHarnessAgentId(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  payload: CronAcpPayload;
}): { ok: true; harnessAgentId: string } | { ok: false; error: string } {
  const explicitHarness = normalizeOptionalString(params.payload.harness);
  const requestedOpenclaw = normalizeOptionalString(params.job.agentId);
  if (explicitHarness) {
    return { ok: true, harnessAgentId: explicitHarness };
  }
  if (requestedOpenclaw) {
    const configuredAgent = params.cfg.agents?.list?.find(
      (agent) => normalizeOptionalAgentId(agent.id) === requestedOpenclaw,
    );
    if (configuredAgent?.runtime?.type === "acp") {
      return {
        ok: true,
        harnessAgentId:
          normalizeOptionalAgentId(configuredAgent.runtime.acp?.agent) ?? requestedOpenclaw,
      };
    }
    return { ok: true, harnessAgentId: requestedOpenclaw };
  }
  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    return { ok: true, harnessAgentId: configuredDefault };
  }
  return {
    ok: false,
    error:
      "ACP cron job requires `agents.list[].runtime.type=acp`, job `agentId`, payload `harness`, or `acp.defaultAgent` in config.",
  };
}

function resolveCronOpenclawAgentId(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  harnessAgentId: string;
}): string {
  const requested = normalizeOptionalString(params.job.agentId);
  if (requested) {
    return normalizeAgentId(requested);
  }
  for (const id of listAgentIds(params.cfg)) {
    const agentCfg = resolveAgentConfig(params.cfg, id);
    if (agentCfg?.runtime?.type !== "acp") {
      continue;
    }
    const harness = normalizeOptionalAgentId(agentCfg.runtime.acp?.agent) ?? normalizeAgentId(id);
    if (harness === params.harnessAgentId) {
      return normalizeAgentId(id);
    }
  }
  return normalizeAgentId(params.harnessAgentId);
}

function resolveCronAcpSourceDeliveryPlan(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
}): SourceDeliveryPlan {
  const target = {
    channel: params.resolvedDelivery.channel,
    to: params.resolvedDelivery.to,
    accountId: params.resolvedDelivery.accountId,
    threadId: params.resolvedDelivery.threadId,
  };
  if (params.deliveryPlan.mode === "webhook") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_webhook",
      messageToolEnabled: false,
      directFallback: false,
    });
  }
  if (params.deliveryPlan.mode === "none") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target,
      messageToolEnabled: true,
      messageToolForced: true,
      directFallback: false,
    });
  }
  return createSourceDeliveryPlan({
    owner: params.resolvedDelivery.ok ? "message_tool_then_direct_fallback" : "direct_fallback",
    reason: "cron_announce",
    target,
    messageToolEnabled: true,
    messageToolForced: true,
    directFallback: true,
    skipFallbackWhenMessageToolSentToTarget: params.resolvedDelivery.ok,
  });
}

function hasExplicitCronDeliveryTarget(plan: CronDeliveryPlan): boolean {
  return Boolean(
    (plan.channel && plan.channel !== "last") || plan.to || plan.threadId || plan.accountId,
  );
}

async function resolveCronAcpDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  openclawAgentId: string;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  if (deliveryPlan.mode === "webhook") {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("webhook delivery has no chat target"),
    };
    return {
      deliveryPlan,
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
      sourceDelivery: resolveCronAcpSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    };
  }
  if (deliveryPlan.mode === "none" && !hasExplicitCronDeliveryTarget(deliveryPlan)) {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("delivery is disabled"),
    };
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery,
      sourceDelivery: resolveCronAcpSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    };
  }
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.openclawAgentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    threadId: deliveryPlan.threadId,
    accountId: deliveryPlan.accountId,
    sessionKey: params.job.sessionKey,
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    sourceDelivery: resolveCronAcpSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
  };
}

function appendCronAcpDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
  resolvedDeliveryOk: boolean;
}): string {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  if (params.resolvedDeliveryOk) {
    return `${params.commandBody}\n\nReturn your response as plain text; it will be delivered automatically to the configured cron delivery target.`.trim();
  }
  return `${params.commandBody}\n\nReturn your response as plain text; cron delivery is configured but the target could not be resolved, so include any destination hints in your reply.`.trim();
}

function collectAcpTurnOutput(event: { type: string; stream?: string; text?: string }, output: string): string {
  if (event.type !== "text_delta") {
    return output;
  }
  if (event.stream && event.stream !== "output") {
    return output;
  }
  if (!event.text) {
    return output;
  }
  const next = output + event.text;
  if (next.length <= ACP_OUTPUT_LIMIT) {
    return next;
  }
  return `${next.slice(0, ACP_OUTPUT_LIMIT)}…`;
}

export async function runCronAcpTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  sessionKey: string;
  agentId?: string;
}): Promise<RunCronAgentTurnResult> {
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const payload = params.job.payload;
  if (payload.kind !== "acpTurn") {
    return {
      status: "error",
      error: "runCronAcpTurn requires payload.kind=acpTurn",
      diagnostics: createCronRunDiagnosticsFromError(
        "cron-preflight",
        "runCronAcpTurn requires payload.kind=acpTurn",
      ),
    };
  }

  const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
  const harnessResult = resolveCronAcpHarnessAgentId({
    cfg: params.cfg,
    job: params.job,
    payload,
  });
  const runSessionId = crypto.randomUUID();
  let acpSessionKey = `agent:cron:${params.job.id}:${crypto.randomUUID()}`;
  const withRunSession = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: acpSessionKey,
  });

  if (!isAcpEnabledByPolicy(params.cfg)) {
    return withRunSession({
      status: "error",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
      diagnostics: createCronRunDiagnosticsFromError(
        "cron-preflight",
        "ACP is disabled by policy (`acp.enabled=false`).",
      ),
    });
  }
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return withRunSession({
      status: "error",
      error: dispatchPolicyError.message,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", dispatchPolicyError.message),
    });
  }
  if (!harnessResult.ok) {
    return withRunSession({
      status: "error",
      error: harnessResult.error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", harnessResult.error),
    });
  }
  const harnessAgentId = harnessResult.harnessAgentId;
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, harnessAgentId);
  if (agentPolicyError) {
    return withRunSession({
      status: "error",
      error: agentPolicyError.message,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", agentPolicyError.message),
    });
  }

  const resolvedOpenclawAgentId = resolveCronOpenclawAgentId({
    cfg: params.cfg,
    job: params.job,
    harnessAgentId,
  });
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: baseSessionKey,
    agentId: resolvedOpenclawAgentId,
    mainKey: params.cfg.session?.mainKey,
    cfg: params.cfg,
  });
  acpSessionKey = `agent:${resolvedOpenclawAgentId}:acp:cron:${params.job.id}:${crypto.randomUUID()}`;

  const { deliveryRequested, resolvedDelivery, sourceDelivery } =
    await resolveCronAcpDeliveryContext({
      cfg: params.cfg,
      job: params.job,
      openclawAgentId: resolvedOpenclawAgentId,
    });

  const now = Date.now();
  const { timeLine } = resolveCronStyleNow(params.cfg, now);
  const commandBody = appendCronAcpDeliveryInstruction({
    commandBody: `[cron:${params.job.id} ${params.job.name}] ${params.message}\n${timeLine}`.trim(),
    deliveryRequested,
    resolvedDeliveryOk: resolvedDelivery.ok,
  });

  const explicitTimeoutSeconds = payload.timeoutSeconds;
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfg,
    overrideSeconds: explicitTimeoutSeconds,
  });

  const cwd =
    normalizeOptionalString(payload.cwd) ??
    resolveAgentWorkspaceDir(params.cfg, resolvedOpenclawAgentId);
  const acpManager = getAcpSessionManager();
  const runStartedAt = Date.now();
  let outputText = "";

  params.onExecutionStarted?.({
    jobId: params.job.id,
    agentId: resolvedOpenclawAgentId,
    sessionId: runSessionId,
    sessionKey: acpSessionKey,
    phase: "runner_entered",
    backend: params.cfg.acp?.backend,
    provider: "acp",
    model: payload.model,
  });
  params.onExecutionPhase?.({
    jobId: params.job.id,
    agentId: resolvedOpenclawAgentId,
    sessionId: runSessionId,
    sessionKey: acpSessionKey,
    phase: "runner_entered",
    backend: params.cfg.acp?.backend,
    provider: "acp",
    model: payload.model,
  });

  try {
    await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      agent: harnessAgentId,
      mode: "oneshot",
      cwd,
      backendId: params.cfg.acp?.backend,
      runtimeOptions:
        payload.model || payload.thinking || payload.timeoutSeconds
          ? {
              ...(payload.model ? { model: payload.model } : {}),
              ...(payload.thinking ? { thinking: payload.thinking } : {}),
              ...(payload.timeoutSeconds ? { timeoutSeconds: payload.timeoutSeconds } : {}),
            }
          : undefined,
    });

    if (isAborted()) {
      return withRunSession({
        status: "error",
        error: abortReason(),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", abortReason()),
      });
    }

    params.onExecutionPhase?.({
      jobId: params.job.id,
      agentId: resolvedOpenclawAgentId,
      sessionId: runSessionId,
      sessionKey: acpSessionKey,
      phase: "model_call_started",
      backend: params.cfg.acp?.backend,
      provider: "acp",
      model: payload.model,
    });

    await acpManager.runTurn({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      text: commandBody,
      mode: "prompt",
      requestId: runSessionId,
      signal: abortSignal,
      onEvent: (event) => {
        outputText = collectAcpTurnOutput(event, outputText);
      },
    });
    outputText = outputText.trim();

    if (isAborted()) {
      return withRunSession({
        status: "error",
        error: abortReason(),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", abortReason()),
      });
    }

    const summary = pickSummaryFromOutput(outputText) ?? outputText.slice(0, 200);
    const runEndedAt = Date.now();
    const deliveryPayloads = outputText ? [{ text: outputText }] : [];
    const sourceDeliveryOutcome = resolveSourceDeliveryOutcome(sourceDelivery, {
      didSendViaMessageTool: false,
      messageToolSentTargets: [],
    });
    const deliveryResult = await dispatchCronDelivery({
      cfg: params.cfg,
      cfgWithAgentDefaults: params.cfg,
      deps: params.deps,
      job: params.job,
      agentId: resolvedOpenclawAgentId,
      agentSessionKey,
      runSessionKey: acpSessionKey,
      sessionId: runSessionId,
      runStartedAt,
      runEndedAt,
      timeoutMs,
      resolvedDelivery,
      deliveryRequested,
      skipHeartbeatDelivery: false,
      sourceDeliveryOutcome,
      deliveryBestEffort: resolveCronDeliveryBestEffort(params.job),
      deliveryPayloadHasStructuredContent: false,
      deliveryPayloads,
      summary,
      outputText,
      telemetry: {
        model: payload.model,
        provider: "acp",
      },
      abortSignal,
      isAborted,
      abortReason,
      withRunSession,
    });
    return (
      deliveryResult.result ??
      withRunSession({
        status: "ok",
        summary,
        outputText,
        delivered: deliveryResult.delivered,
        deliveryAttempted: deliveryResult.deliveryAttempted,
        model: payload.model,
        provider: "acp",
      })
    );
  } catch (error) {
    const message = formatAcpErrorChain(error);
    return withRunSession({
      status: "error",
      error: message,
      outputText: outputText.trim() || undefined,
      diagnostics: createCronRunDiagnosticsFromError("agent-run", message),
      model: payload.model,
      provider: "acp",
    });
  } finally {
    try {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        reason: "cron-acp-turn-complete",
        discardPersistentState: true,
        clearMeta: true,
        allowBackendUnavailable: true,
      });
    } catch {
      // Best-effort cleanup for one-shot cron ACP sessions.
    }
  }
}
