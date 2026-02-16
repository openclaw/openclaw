import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import {
  createOrchestratorRequest,
  waitForResolution,
  getOrchestratorRequest,
} from "../orchestrator-request-registry.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { getRunByChildKey } from "../subagent-registry.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const ORCHESTRATOR_PRIORITIES = ["normal", "high"] as const;

const RequestOrchestratorSchema = Type.Object({
  message: Type.String({
    minLength: 1,
    description: "Question or request for the parent orchestrator",
  }),
  context: Type.Optional(
    Type.String({ description: "Additional context (file paths, data, partial results)" }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 10,
      maximum: 3600,
      description: "Max wait time. Default: 300",
    }),
  ),
  priority: optionalStringEnum(ORCHESTRATOR_PRIORITIES),
});

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (a && !b) {
    return a;
  }
  if (b && !a) {
    return b;
  }
  if (a?.aborted) {
    return a;
  }
  if (b?.aborted) {
    return b;
  }
  if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function createRequestOrchestratorTool(opts?: {
  agentSessionKey?: string;
  runId?: string;
  runTimeoutMs?: number;
  runStartedAt?: number;
  abortSignal?: AbortSignal;
}): AnyAgentTool {
  return {
    label: "Orchestrator",
    name: "request_orchestrator",
    description:
      "Request input from the parent orchestrator. Blocks until the parent responds, times out, or the run is aborted.",
    parameters: RequestOrchestratorSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      const context = readStringParam(params, "context");
      const timeoutSecondsRaw = readNumberParam(params, "timeoutSeconds") ?? 300;
      const timeoutSeconds = Math.max(10, Math.min(3600, Math.floor(timeoutSecondsRaw)));
      const priority = (params.priority as "normal" | "high") === "high" ? "high" : "normal";

      const currentSessionKey = opts?.agentSessionKey?.trim() ?? "";

      // 1. Validate caller is a subagent
      if (!isSubagentSessionKey(currentSessionKey)) {
        return jsonResult({
          status: "error",
          error: "request_orchestrator is only available to subagent sessions.",
        });
      }

      // 2. Resolve parent
      const run = getRunByChildKey(currentSessionKey);
      if (!run) {
        return jsonResult({
          status: "error",
          error: "Could not resolve parent session. No run record found.",
        });
      }
      const parentSessionKey = run.requesterSessionKey;

      // 3. Check parent availability (best-effort)
      let parentAvailable = true;
      try {
        const resolved = await callGateway<{ key?: string }>({
          method: "sessions.resolve",
          params: {
            key: parentSessionKey,
          },
          timeoutMs: 5_000,
        });
        parentAvailable = typeof resolved?.key === "string" && resolved.key.trim().length > 0;
      } catch {
        parentAvailable = false;
      }

      if (!parentAvailable) {
        return jsonResult({
          status: "parent_unavailable",
          error: "Parent session is not active.",
        });
      }

      // 4. Compute effective timeout
      const requestedTimeoutMs = timeoutSeconds * 1000;
      let effectiveTimeoutMs = requestedTimeoutMs;

      if (
        typeof opts?.runTimeoutMs === "number" &&
        Number.isFinite(opts.runTimeoutMs) &&
        opts.runTimeoutMs > 0 &&
        typeof opts?.runStartedAt === "number" &&
        Number.isFinite(opts.runStartedAt)
      ) {
        const elapsed = Date.now() - opts.runStartedAt;
        const remainingMs = opts.runTimeoutMs - elapsed;
        const bufferMs = 30_000;
        if (remainingMs - bufferMs <= 0) {
          return jsonResult({
            status: "timeout",
            error: "Insufficient remaining run time for orchestrator request.",
          });
        }
        effectiveTimeoutMs = Math.min(requestedTimeoutMs, remainingMs - bufferMs);
      }
      const effectiveTimeoutSeconds = Math.max(1, Math.floor(effectiveTimeoutMs / 1000));

      // 5. Create request record
      let requestId: string;
      try {
        requestId = createOrchestratorRequest({
          childSessionKey: currentSessionKey,
          parentSessionKey,
          runId: opts?.runId,
          message,
          context,
          priority,
          timeoutMs: effectiveTimeoutMs,
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const request = getOrchestratorRequest(requestId);
      const timeoutAt = request?.timeoutAt ? new Date(request.timeoutAt).toISOString() : undefined;

      // 6. Deliver parent notification
      const notificationText = [
        `[subagent_request requestId=${requestId}]`,
        `From: ${currentSessionKey}`,
        run.label ? `Label: "${run.label}"` : undefined,
        `Priority: ${priority}`,
        `Timeout: ${effectiveTimeoutSeconds}s${timeoutAt ? ` (expires at ${timeoutAt})` : ""}`,
        "",
        `Question: ${message}`,
        context ? `Context: ${context}` : undefined,
        "",
        "---",
        `Respond: respond_orchestrator_request(requestId="${requestId}", response="your guidance")`,
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      try {
        await callGateway({
          method: "agent",
          params: {
            message: notificationText,
            sessionKey: parentSessionKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
          },
          timeoutMs: 10_000,
        });
      } catch {
        // Notification delivery is best-effort
      }

      // 7. Emit agent event
      if (opts?.runId) {
        emitAgentEvent({
          runId: opts.runId,
          stream: "orchestrator_request",
          data: {
            requestId,
            childSessionKey: currentSessionKey,
            parentSessionKey,
            message,
            priority,
            timeoutAt: request?.timeoutAt,
          },
        });
      }

      // 8. Block on resolution
      try {
        const combinedAbortSignal = combineAbortSignals(signal, opts?.abortSignal);
        const resolved = await waitForResolution(
          requestId,
          effectiveTimeoutMs,
          combinedAbortSignal,
        );

        return jsonResult({
          status: resolved.status,
          requestId,
          response: resolved.response,
          error: resolved.error,
          respondedAt: resolved.resolvedAt,
        });
      } catch (err) {
        // Abort signal
        return jsonResult({
          status: "cancelled",
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
