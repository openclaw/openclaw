import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
} from "../../auto-reply/continuation/config.js";
import type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-authority.js";
import { formatCurrentSpanContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readToolStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("continuation/continue-work");

export type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";

const ContinueWorkToolSchema = Type.Object({
  reason: Type.String({
    description:
      "Why another turn is needed before you yield. Logged for diagnostics and continuation context.",
    maxLength: 1024,
  }),
  delaySeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Seconds to wait before the next turn fires. 0 or omitted = immediate. " +
        "Positive delays are clamped to continuation.minDelayMs / maxDelayMs from config.",
    }),
  ),
});

type ContinueWorkToolOpts = {
  agentSessionKey?: string;
  requestContinuation: (request: ContinueWorkRequest) => void | Promise<void>;
};

export function createContinueWorkTool(opts: ContinueWorkToolOpts): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_work",
    description: [
      "Arm your next turn in this session.",
      "You run only when an inbound message arrives, a scheduled automation fires, or a continuation you armed wakes you; if you end a turn without arming one, nothing else wakes you.",
      "Use this when concrete follow-up work remains that cannot finish in the current turn: reason names that work; the turn starts after this one ends, or delaySeconds later.",
      "Do not use continue_work to wait, yield, stand by, park, or keep the session alive after all tasks are complete.",
      "To wait for a delegate or sub-agent you already started, use sessions_yield; its result wakes you. Otherwise schedule no continuation.",
    ].join(" "),
    parameters: ContinueWorkToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("continue_work arguments must be an object.");
      }
      const params = args;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_work requires an active session. Not available in sessionless contexts.",
        );
      }

      const reason = readToolStringParam(params, "reason", { required: true }).slice(0, 1024);
      const parsedDelaySeconds = readNumberParam(params, "delaySeconds", { strict: true });
      if (parsedDelaySeconds !== undefined && parsedDelaySeconds < 0) {
        throw new ToolInputError("delaySeconds must be a non-negative number.");
      }
      const delaySeconds = parsedDelaySeconds ?? 0;
      const traceparent = formatCurrentSpanContinuationTraceparent();
      const traceContextFields = traceparent ? { traceparent } : {};

      log.debug(
        `[continue_work:request] session=${sessionKey} delaySeconds=${delaySeconds} reason=${reason.slice(0, 80)}`,
      );
      const preparation = captureOperatorToolGatewayContinuationContext({ sessionKey });
      const captured = preparation ? await preparation : undefined;
      // No operator source means the existing system-event wake, not a borrowed
      // request-client lifetime. Only operator-owned work needs retained policy.
      const operatorContinuation = captured?.operatorAuthority ? captured : undefined;
      if (!operatorContinuation) {
        captured?.release();
      }
      try {
        await opts.requestContinuation({
          reason,
          delaySeconds,
          ...traceContextFields,
          ...(operatorContinuation ? { operatorContinuation } : {}),
        });
      } catch (error) {
        operatorContinuation?.release();
        throw error;
      }

      // Report the resolved delay (post-clamp) so the model knows when its
      // next turn will actually fire, not just the raw input value.
      const continuationConfig = resolveContinuationRuntimeConfig();
      const resolvedDelayMs = clampDelayMs(delaySeconds * 1000, continuationConfig);
      const resolvedDelaySeconds = Math.round(resolvedDelayMs / 1000);

      return jsonResult({
        status: "scheduled",
        delaySeconds: resolvedDelaySeconds,
        ...(resolvedDelaySeconds !== delaySeconds
          ? {
              note: `Requested ${delaySeconds}s, clamped to ${resolvedDelaySeconds}s by continuation config.`,
            }
          : {}),
      });
    },
  };
}
