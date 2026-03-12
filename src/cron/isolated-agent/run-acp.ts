import crypto from "node:crypto";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import type { AcpRunTurnInput } from "../../acp/control-plane/manager.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../../acp/policy.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { DEFAULT_JOB_TIMEOUT_MS } from "../service/timeout-policy.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
import { dispatchCronDelivery, resolveCronDeliveryBestEffort } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";

export type RunCronAcpTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob; // payload.kind must be "acpTurn"
  message: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionKey: string;
  lane?: string;
};

/**
 * Execute an `acpTurn` cron job using the ACP session manager directly.
 *
 * This is the first-class ACP runtime path for cron:
 * - Checks ACP policy and agent allowlist before execution.
 * - Calls `AcpSessionManager.initializeSession()` with `mode: "oneshot"` to
 *   create a fresh, isolated ACP session that auto-closes after the run.
 * - Calls `AcpSessionManager.runTurn()` which drives the ACP runtime and
 *   awaits full completion (collects `text_delta` events as output).
 * - Delivers the output via the standard cron delivery dispatch machinery,
 *   so announce/webhook/none delivery behavior matches `agentTurn` runs.
 * - Returns an explicit error if no ACP backend is configured or the harness
 *   is unavailable, rather than silently skipping.
 *
 * Limitations (MVP):
 * - `payload.model` is stored in the payload but not yet forwarded to
 *   `initializeSession` or `runTurn`. ACP backends configure their own model;
 *   per-run model overrides require backend-specific session init params not
 *   yet exposed here. Track as follow-up.
 * - No token usage telemetry: `CronRunTelemetry.usage` is always empty.
 *   Follow-up: parse `usage_update` ACP events when backends emit them.
 * - `payload.cwd` is passed to `initializeSession`; backend support varies.
 */
export async function runCronAcpTurn(
  params: RunCronAcpTurnParams,
): Promise<RunCronAgentTurnResult> {
  const payload = params.job.payload;
  if (payload.kind !== "acpTurn") {
    return {
      status: "error",
      error: `runCronAcpTurn: expected acpTurn payload, got "${payload.kind}"`,
    };
  }

  // Explicit ACP policy checks — fail loudly so users know why the job didn't run.
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return {
      status: "error",
      error: "ACP unavailable: ACP is disabled by policy (`acp.enabled=false`)",
    };
  }

  const resolvedAcpAgentId = (payload.acpAgentId?.trim() || "").toLowerCase() || undefined;
  if (resolvedAcpAgentId) {
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgentId);
    if (agentPolicyError) {
      return {
        status: "error",
        error: `ACP agent not allowed: ${agentPolicyError.message}`,
      };
    }
  }

  const abortSignal = params.abortSignal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => "cron: job execution timed out";

  if (isAborted()) {
    return { status: "error", error: abortReason() };
  }

  // Resolve agent/delivery context using the same pattern as runCronIsolatedAgentTurn.
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const agentId = requestedAgentId ?? defaultAgentId;
  // For ACP runs, we don't override OpenClaw model routing — the ACP runtime
  // manages its own model selection. Use cfg as-is for delivery plumbing.
  const cfgWithAgentDefaults = params.cfg;

  const agentSessionKey = params.sessionKey;

  // Generate a unique ACP session key for this run so each cron trigger gets
  // a fresh oneshot session (no state leakage between runs).
  const runId = crypto.randomUUID();
  const acpSessionKey = `cron-acp:${params.job.id}:${runId.slice(0, 8)}`;

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds: payload.timeoutSeconds,
  });

  // Resolve delivery target before execution so a bad target fails early.
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    accountId: deliveryPlan.accountId,
    sessionKey: params.job.sessionKey,
  });

  const acpManager = getAcpSessionManager();
  const runStartedAt = Date.now();

  // Initialize a one-shot ACP session. Will throw AcpRuntimeError if:
  // - no ACP backend is configured (`acp.backend` not set or backend plugin not loaded)
  // - the backend process cannot be started
  // We surface these as explicit "error" outcomes rather than panicking.
  try {
    await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      agent: resolvedAcpAgentId ?? "claude",
      mode: "oneshot",
      cwd: payload.cwd,
    });
  } catch (err) {
    const errMsg =
      err instanceof AcpRuntimeError
        ? `ACP session init failed (${err.code}): ${err.message}`
        : `ACP session init failed: ${String(err)}`;
    return { status: "error", error: errMsg, sessionKey: agentSessionKey };
  }

  if (isAborted()) {
    // Best-effort close; don't let cleanup errors shadow the abort.
    void acpManager
      .closeSession({ cfg: params.cfg, sessionKey: acpSessionKey, reason: "cron-aborted" })
      .catch(() => undefined);
    return { status: "error", error: abortReason(), sessionKey: agentSessionKey };
  }

  // Run the ACP turn and collect output text from text_delta events.
  const outputParts: string[] = [];
  let turnError: AcpRuntimeError | undefined;

  const turnInput: AcpRunTurnInput = {
    cfg: params.cfg,
    sessionKey: acpSessionKey,
    text: params.message,
    mode: "prompt",
    requestId: runId,
    signal: abortSignal,
    onEvent: (event) => {
      // Collect only primary output text, not thought/reasoning stream.
      if (event.type === "text_delta" && event.stream !== "thought") {
        outputParts.push(event.text);
      }
    },
  };

  try {
    await acpManager.runTurn(turnInput);
  } catch (err) {
    turnError =
      err instanceof AcpRuntimeError ? err : new AcpRuntimeError("ACP_TURN_FAILED", String(err));
  }

  const runEndedAt = Date.now();
  const outputText = outputParts.join("").trim() || undefined;
  const summary = outputText;

  if (isAborted()) {
    return { status: "error", error: abortReason(), sessionKey: agentSessionKey, summary };
  }

  if (turnError) {
    return {
      status: "error",
      error: `ACP turn failed (${turnError.code}): ${turnError.message}`,
      summary: outputText,
      sessionKey: agentSessionKey,
    };
  }

  const telemetry: CronRunTelemetry = {}; // No token usage from ACP events yet (MVP)

  const withRunSession = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: runId,
    sessionKey: agentSessionKey,
  });

  const deliveryBestEffort = resolveCronDeliveryBestEffort(params.job);
  const deliveryPayloads = outputText ? [{ text: outputText }] : [];

  const deliveryResult = await dispatchCronDelivery({
    cfg: params.cfg,
    cfgWithAgentDefaults,
    deps: params.deps,
    job: params.job,
    agentId,
    agentSessionKey,
    runSessionId: runId,
    runStartedAt,
    runEndedAt,
    timeoutMs: timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    resolvedDelivery,
    deliveryRequested: deliveryPlan.requested,
    skipHeartbeatDelivery: false,
    skipMessagingToolDelivery: false,
    deliveryBestEffort,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads,
    synthesizedText: outputText,
    summary,
    outputText,
    telemetry,
    abortSignal,
    isAborted,
    abortReason,
    withRunSession,
  });

  if (deliveryResult.result) {
    return deliveryResult.result;
  }

  return withRunSession({
    status: "ok",
    summary: deliveryResult.summary,
    outputText: deliveryResult.outputText,
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
    ...telemetry,
  });
}
