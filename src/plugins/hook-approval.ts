/**
 * Shared plugin approval client for human-in-the-loop authorization hooks.
 *
 * Reuses the existing `plugin.approval.*` gateway RPC infrastructure that
 * powers `before_tool_call.requireApproval` and lifecycle gate `ask`.
 */

import { callGatewayTool } from "../agents/tools/gateway.js";
import type { HookDecisionAsk } from "./hook-decision-types.js";
import { PluginApprovalResolutions, type PluginApprovalResolution } from "./hook-types.js";

export type HookApprovalResult = "allow-once" | "deny" | "timeout" | "cancelled";

export type PluginApprovalClientFailure = "missing-id" | "no-route" | "aborted" | "gateway-error";

export type PluginApprovalClientResult = {
  decision: PluginApprovalResolution;
  id?: string;
  failure?: PluginApprovalClientFailure;
  error?: unknown;
};

export type RequestPluginApprovalParams = {
  pluginId?: string;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  allowedDecisions?: readonly PluginApprovalResolution[];
  timeoutMs?: number;
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  signal?: AbortSignal;
  log?: { warn: (msg: string) => void };
  logLabel?: string;
};

export type SingleHookApprovalParams = {
  hookPoint: string;
  decision: HookDecisionAsk;
  pluginId?: string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  signal?: AbortSignal;
  log?: { warn: (msg: string) => void };
};

/**
 * Request human approval for one hook decision.
 * Hook approvals intentionally do not grant durable "allow always" trust.
 * On timeout, the caller applies the hook's timeout behavior.
 */
export async function requestSingleHookApproval(
  params: SingleHookApprovalParams,
): Promise<HookApprovalResult> {
  const result = await requestPluginApproval({
    pluginId: params.pluginId ?? `hook:${params.hookPoint}`,
    title: params.decision.title,
    description: params.decision.description,
    severity: params.decision.severity ?? "warning",
    allowedDecisions: [PluginApprovalResolutions.ALLOW_ONCE, PluginApprovalResolutions.DENY],
    timeoutMs: params.decision.timeoutMs,
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    signal: params.signal,
    log: params.log,
    logLabel: params.hookPoint,
  });

  return result.decision === PluginApprovalResolutions.ALLOW_ALWAYS
    ? PluginApprovalResolutions.ALLOW_ONCE
    : result.decision;
}

export async function requestPluginApproval(
  params: RequestPluginApprovalParams,
): Promise<PluginApprovalClientResult> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const label = params.logLabel ?? params.pluginId ?? "plugin approval";

  if (params.signal?.aborted) {
    params.log?.warn?.(`plugin approval cancelled before request for ${label}`);
    return {
      decision: PluginApprovalResolutions.CANCELLED,
      failure: "aborted",
      error: params.signal.reason,
    };
  }

  try {
    const requestResult = await callGatewayTool(
      "plugin.approval.request",
      { timeoutMs: timeoutMs + 10_000, deviceIdentity: null },
      // Approval requests originate inside trusted agent/plugin runtime code.
      // Avoid binding these internal RPCs to the UI device identity; otherwise a
      // read-only control UI token turns the approval request itself into an
      // impossible operator.approvals scope upgrade.
      {
        pluginId: params.pluginId,
        title: params.title,
        description: params.description,
        severity: params.severity,
        allowedDecisions: params.allowedDecisions,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );

    const id = readStringField(requestResult, "id");
    if (!id) {
      params.log?.warn?.(`plugin approval request failed (no id returned) for ${label}`);
      return { decision: PluginApprovalResolutions.CANCELLED, failure: "missing-id" };
    }

    const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
      requestResult ?? {},
      "decision",
    );

    let rawDecision: string | null | undefined;

    if (hasImmediateDecision) {
      rawDecision = readNullableStringField(requestResult, "decision");
      if (rawDecision === null) {
        params.log?.warn?.(`plugin approval unavailable (no approval route) for ${label}`);
        return { decision: PluginApprovalResolutions.CANCELLED, id, failure: "no-route" };
      }
    } else {
      const waitPromise = callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: timeoutMs + 10_000, deviceIdentity: null },
        { id },
      );

      let waitResult: Record<string, unknown> | undefined;

      if (params.signal) {
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (params.signal!.aborted) {
            reject(params.signal!.reason);
            return;
          }
          onAbort = () => reject(params.signal!.reason);
          params.signal!.addEventListener("abort", onAbort, { once: true });
        });
        try {
          waitResult = await Promise.race([waitPromise, abortPromise]);
        } finally {
          if (onAbort) {
            params.signal.removeEventListener("abort", onAbort);
          }
        }
      } else {
        waitResult = await waitPromise;
      }

      rawDecision = waitResult ? readNullableStringField(waitResult, "decision") : undefined;
    }

    return { decision: normalizeDecision(rawDecision), id };
  } catch (err) {
    if (isAbortCancellation(err, params.signal)) {
      params.log?.warn?.(`plugin approval cancelled by run abort for ${label}: ${String(err)}`);
      return { decision: PluginApprovalResolutions.CANCELLED, failure: "aborted", error: err };
    }
    params.log?.warn?.(
      `plugin approval gateway request failed for ${label}, treating as cancelled: ${String(err)}`,
    );
    return { decision: PluginApprovalResolutions.CANCELLED, failure: "gateway-error", error: err };
  }
}

function readStringField(record: unknown, field: string): string | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = Reflect.get(record, field);
  return typeof value === "string" ? value : undefined;
}

function readNullableStringField(record: unknown, field: string): string | null | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = Reflect.get(record, field);
  return typeof value === "string" || value === null ? value : undefined;
}

function normalizeDecision(raw: string | null | undefined): PluginApprovalResolution {
  if (
    raw === PluginApprovalResolutions.ALLOW_ONCE ||
    raw === PluginApprovalResolutions.ALLOW_ALWAYS ||
    raw === PluginApprovalResolutions.DENY
  ) {
    return raw;
  }
  return PluginApprovalResolutions.TIMEOUT;
}

function isAbortCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}
