import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import type { UnsettledRequesterChild } from "../subagents/registry/subagent-registry-requester-yield.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const NO_PENDING_CHILD_COMPLETION_MESSAGE =
  'No pending child completion is owned by this turn. This call did not pause the turn or schedule a continuation. Continue unfinished work; return its final result when complete. For background tools, follow their result\'s continuation instructions. Set waitFor: "message" only in a subagent session that is waiting for its requester to send it a continuation.';

const WAIT_FOR_NOT_APPLIED_NOTE =
  'waitFor: "message" was not applied: this turn yielded for its own pending child completions, which resume this session. Omit waitFor when yielding for children.';

/**
 * A harness runtime's yield claim: true when this turn owns a pending completion,
 * or the children an earlier turn left pending that will resume the session.
 */
export type SessionsYieldRuntimeClaim =
  | boolean
  | { pendingChildren: readonly UnsettledRequesterChild[] };
export type SessionsYieldClaimResult =
  | SessionsYieldRuntimeClaim
  | { schedulerOwned: true }
  | { messageWaitRegistered: boolean }
  | { error: string };
export type SessionsYieldIntent = { waitFor?: "message"; acknowledgment?: string };
export type SessionsYieldCallback = (
  message: string,
  acknowledgment?: string,
  messageWaitRegistered?: boolean,
) => Promise<void> | void;

function describePendingChild(child: UnsettledRequesterChild): string {
  const name = child.label ? `${child.label} (${child.childSessionKey})` : child.childSessionKey;
  const started =
    typeof child.startedAt === "number"
      ? `, started ${new Date(child.startedAt).toISOString()}`
      : "";
  return `${name}, ${child.state}${started}`;
}

function describeChildCount(count: number): string {
  return `${count} ${count === 1 ? "child session" : "child sessions"}`;
}

function formatPendingChildrenMessage(children: readonly UnsettledRequesterChild[]): string {
  const paused = children.filter((child) => child.state === "paused");
  const active = children.filter((child) => child.state !== "paused");
  const parts: string[] = [];
  if (active.length > 0) {
    const owner = active.some((child) => child.wakeArmed)
      ? "An earlier turn of this session already yielded for"
      : "An earlier turn of this session already spawned";
    parts.push(
      `${owner} ${describeChildCount(active.length)} whose completion is still pending: ${active.map(describePendingChild).join("; ")}. Their completion will arrive in this session as a later turn; do not re-spawn, re-send, or poll to wake them.`,
    );
  }
  if (paused.length > 0) {
    parts.push(
      `${describeChildCount(paused.length)} spawned by an earlier turn of this session ${paused.length === 1 ? "is" : "are"} paused by ${paused.length === 1 ? "its" : "their"} own sessions_yield and will not complete until an incoming continuation arrives: ${paused.map(describePendingChild).join("; ")}. An authorized caller can send that continuation with sessions_send; owning a child does not grant that tool. Otherwise the work stays waiting.`,
    );
  }
  parts.push("This turn owns no new claim, so no yield is needed: end this turn normally.");
  return parts.join(" ");
}

const SessionsYieldToolSchema = Type.Object({
  waitFor: Type.Optional(
    Type.Literal("message", {
      description:
        "Only for a subagent with no pending children of its own that waits for its requester to send it a continuation. Omit when yielding for your own children: their completions resume this session. Does not send or schedule that message or submit a final result.",
    }),
  ),
  message: Type.Optional(
    Type.String({ description: "Private context for the resumed turn; not sent to the user." }),
  ),
  acknowledgment: Type.Optional(
    Type.String({
      description:
        "Optional waiting reply in this session; with waitFor, text for an eligible task pause notice. Not an inter-session message.",
    }),
  ),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  claimYield?: (
    intent?: SessionsYieldIntent,
  ) => SessionsYieldClaimResult | Promise<SessionsYieldClaimResult>;
  onYield?: SessionsYieldCallback;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    // Turn-lifecycle contract: spawn flows instruct the model to yield, so the
    // tool must stay visible even when tool search compacts the catalog.
    catalogMode: "direct-only",
    // A yield waits, so it must pause an async-tool response: the next request then
    // delivers this response's async results ahead of the yield result.
    async: false,
    description:
      'End this turn to await pending child completions, not submit a final result. Return completed work normally. Does not message other sessions. Omit waitFor when yielding for your own children; their completions resume this session. Set waitFor:"message" only when a subagent has no pending children and waits for its requester to send it a continuation. For background tools, follow their continuation instructions. Automation turns end here; the scheduler delivers child output under the job delivery policy. Collector runs require explicit collection instead.',
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
            "Earlier async tool results from this response arrive with this result. Use them, then yield again only if external work still requires waiting.",
        });
      }
      const claim = await opts.claimYield?.(
        waitFor ? { waitFor, ...(acknowledgment ? { acknowledgment } : {}) } : undefined,
      );
      if (typeof claim === "object" && "pendingChildren" in claim) {
        // Not an error: the session already waits for these children through
        // durable registry state, so the model only needs to end the turn.
        return jsonResult({
          status: "already_pending",
          message: formatPendingChildrenMessage(claim.pendingChildren),
          pendingChildren: claim.pendingChildren,
        });
      }
      if (typeof claim === "object" && "error" in claim) {
        return jsonResult({ status: "error", error: claim.error });
      }
      if (claim !== true && typeof claim !== "object") {
        // Advisory, not a failure: the model keeps the turn and nothing the user asked for failed.
        return jsonResult({
          status: "nothing_pending",
          message:
            waitFor === "message"
              ? "No pending completion or eligible active native task is owned by this turn. This call did not pause the turn or schedule a continuation. Continue unfinished work; return its final result when complete."
              : NO_PENDING_CHILD_COMPLETION_MESSAGE,
        });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(
        message,
        acknowledgment,
        typeof claim === "object" && "messageWaitRegistered" in claim
          ? claim.messageWaitRegistered
          : undefined,
      );
      return jsonResult({
        status: "yielded",
        ...(acknowledgment ? { acknowledgment } : {}),
        // A completion claim resumes this session itself, so the runtime records no message wait.
        ...(typeof claim === "object" && "schedulerOwned" in claim
          ? {
              note: "Turn ended. The scheduler delivers child output under the job's delivery policy.",
            }
          : waitFor === "message" && claim === true
            ? { note: WAIT_FOR_NOT_APPLIED_NOTE }
            : {}),
      });
    },
  };
}
