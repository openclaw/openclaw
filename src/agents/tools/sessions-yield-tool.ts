/**
 * sessions_yield built-in tool.
 *
 * Ends the current turn after subagent spawning so completion events can resume the session later.
 */
import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const NO_PENDING_CHILD_COMPLETION_ERROR =
  'No pending child completion is owned by this turn. If the assigned work is complete, return its result normally. An unfinished subagent waiting for an incoming continuation must explicitly set waitFor: "message".';

type SessionsYieldClaimResult = boolean | { error: string };
export type SessionsYieldIntent = { waitFor?: "message" };

const SessionsYieldToolSchema = Type.Object({
  waitFor: Type.Optional(
    Type.Literal("message", {
      description:
        "Explicitly pause an unfinished subagent until an incoming continuation message. Does not schedule a message or submit the final result.",
    }),
  ),
  message: Type.Optional(
    Type.String({ description: "Private context for the resumed turn; not sent to the user." }),
  ),
  acknowledgment: Type.Optional(
    Type.String({
      description: "Optional waiting reply for an otherwise-silent interactive parent turn.",
    }),
  ),
});

/** Creates the sessions_yield tool for runtimes that support yield callbacks. */
export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  claimYield?: (
    intent?: SessionsYieldIntent,
  ) => SessionsYieldClaimResult | Promise<SessionsYieldClaimResult>;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    // Turn-lifecycle contract: spawn flows instruct the model to yield, so the
    // tool must stay visible even when tool search compacts the catalog.
    catalogMode: "direct-only",
    description:
      'End this turn for pending child completion events; this is not a final-result submission. Return completed work normally. An unfinished subagent waiting for an incoming continuation must set waitFor:"message". Collector runs require explicit collection instead. acknowledgment can send a waiting reply for an otherwise-silent interactive parent.',
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readToolStringParam(params, "message") || "Turn yielded.";
      const acknowledgment = readToolStringParam(params, "acknowledgment") || undefined;
      const waitFor = readToolStringParam(params, "waitFor");
      if (waitFor !== undefined && waitFor !== "message") {
        return jsonResult({ status: "error", error: 'waitFor must be "message" when provided.' });
      }
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      if (getAgentToolExecutionContext()?.hasUnobservedAsyncToolResults) {
        return jsonResult({
          status: "deferred",
          message:
            "Earlier async tool results are still being delivered. Finish this response to receive them, then yield again only if external work still requires waiting.",
        });
      }
      const claim = await opts.claimYield?.(waitFor ? { waitFor } : undefined);
      if (claim !== true) {
        return jsonResult({
          status: "error",
          error: typeof claim === "object" ? claim.error : NO_PENDING_CHILD_COMPLETION_ERROR,
        });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(message, acknowledgment);
      return jsonResult({
        status: "yielded",
        ...(acknowledgment ? { acknowledgment } : {}),
      });
    },
  };
}
