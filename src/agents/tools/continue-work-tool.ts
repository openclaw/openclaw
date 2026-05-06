import { Type } from "typebox";
import type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";

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
        "Clamped to continuation.minDelayMs / maxDelayMs from config.",
    }),
  ),
});

export type ContinueWorkToolOpts = {
  agentSessionKey?: string;
  requestContinuation: (request: ContinueWorkRequest) => void;
};

export function createContinueWorkTool(opts: ContinueWorkToolOpts): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_work",
    description:
      "Request another turn for this session. Use when you have more work to do but want to yield the current turn first. " +
      "Equivalent to CONTINUE_WORK bracket syntax but as a structured tool call.",
    parameters: ContinueWorkToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_work requires an active session. Not available in sessionless contexts.",
        );
      }

      const reason = readStringParam(params, "reason", { required: true }).slice(0, 1024);
      const parsedDelaySeconds = readNumberParam(params, "delaySeconds", { strict: true });
      if (parsedDelaySeconds !== undefined && parsedDelaySeconds < 0) {
        throw new ToolInputError("delaySeconds must be a non-negative number.");
      }
      const delaySeconds = parsedDelaySeconds ?? 0;

      log.debug(
        `[continue_work:request] session=${sessionKey} delaySeconds=${delaySeconds} reason=${reason.slice(0, 80)}`,
      );
      opts.requestContinuation({
        reason,
        delaySeconds,
      });

      return jsonResult({
        status: "scheduled",
        delaySeconds,
      });
    },
  };
}
