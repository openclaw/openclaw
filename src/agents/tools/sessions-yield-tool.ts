import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import type { UnsettledRequesterChild } from "../subagents/registry/subagent-registry-requester-yield.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const NO_PENDING_CHILD_COMPLETION_MESSAGE =
  'No pending child completion is owned by this turn. This call did not pause the turn or schedule a continuation. Continue unfinished work; return its final result when complete. For background tools, follow their result\'s continuation instructions. An unfinished subagent waiting for an incoming continuation must explicitly set waitFor: "message".';

export type SessionsYieldClaimResult =
  | boolean
  | { messageWaitRegistered: boolean }
  | { error: string }
  | { pendingChildren: readonly UnsettledRequesterChild[] };
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
        "Explicitly pause an unfinished subagent until an incoming continuation message; its requester is notified once. Does not schedule a message or submit the final result.",
    }),
  ),
  message: Type.Optional(
    Type.String({ description: "Private context for the resumed turn; not sent to the user." }),
  ),
  acknowledgment: Type.Optional(
    Type.String({
      description:
        "Optional waiting reply for an otherwise-silent interactive parent turn; with waitFor, the pause notice for the requester.",
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
    description:
      'End this turn for pending child completion events; this is not a final-result submission. For background tools, follow their result\'s continuation instructions. Return completed work normally. An unfinished subagent waiting for an incoming continuation must set waitFor:"message". Collector runs require explicit collection instead. acknowledgment can send a waiting reply for an otherwise-silent interactive parent.',
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
        typeof claim === "object" ? claim.messageWaitRegistered : undefined,
      );
      return jsonResult({
        status: "yielded",
        ...(acknowledgment ? { acknowledgment } : {}),
      });
    },
  };
}
