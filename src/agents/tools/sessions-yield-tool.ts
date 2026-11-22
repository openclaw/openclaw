import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import type { UnsettledRequesterChild } from "../subagents/registry/subagent-registry-requester-yield.js";
import { normalizeToolPolicyName } from "../tool-policy-shared.js";
import { readToolResultDetails, readToolResultStatus } from "../tool-result-error.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const NO_PENDING_CHILD_COMPLETION_MESSAGE =
  "Nothing is pending that can resume this session: no child completion, background command with a completion notifier, or registered wake source. This call did not end or pause your turn. Reply to the user now. If work is unfinished, continue it or start the work you intended to wait for before yielding.";

const WAIT_FOR_NOT_APPLIED_NOTE =
  'waitFor: "message" was not applied: this turn yielded for its own pending child completions or background commands, which resume this session. Omit waitFor when yielding for them.';

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
  // The run's owner resumes it in its current operation after awaited commands exit.
  | { resumesInPlace: true }
  | { messageWaitRegistered: boolean }
  | { error: string };
export type SessionsYieldIntent = { waitFor?: "message"; acknowledgment?: string };
export type SessionsYieldCallback = (
  message: string,
  acknowledgment?: string,
  messageWaitRegistered?: boolean,
  options?: {
    conditional?: true;
    terminal?: import("../agent-tools.abort.js").ToolTurnHandoff;
    /** End the turn but keep the reply operation open for the run's in-place resume. */
    resumesInPlace?: true;
  },
) => Promise<void> | void;

/** Only an active child with an armed wake resumes this session after the turn ends. */
function hasResumingPendingChild(children: readonly unknown[]): boolean {
  return children.some(
    (child) =>
      typeof child === "object" &&
      child !== null &&
      Reflect.get(child, "wakeArmed") === true &&
      Reflect.get(child, "state") !== "paused",
  );
}

/**
 * A later turn's yield found an earlier turn's children still pending, and at least one of
 * them will wake this session. When that turn already delivered its visible reply through the
 * message tool, the runtime ends it here: the reply is out and the earlier wake resumes the
 * session, so trailing text is not a reply. Paused or unarmed children resume nothing, so
 * their already_pending result keeps the turn for the model to act on.
 */
export function isResumingAlreadyPendingSessionsYieldResult(
  toolName: string,
  result: unknown,
): boolean {
  if (
    normalizeToolPolicyName(toolName) !== "sessions_yield" ||
    readToolResultStatus(result) !== "already_pending"
  ) {
    return false;
  }
  const children = readToolResultDetails(result)?.pendingChildren;
  return Array.isArray(children) && hasResumingPendingChild(children);
}

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
        "Optional brief waiting status shown to the user as your message; put answers in normal assistant text. With waitFor, also the task pause notice. Not an inter-session message.",
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
    repeatable: true,
    description:
      'End this turn only to await registered child completions or wake-armed background commands (their exit resumes this session). If nothing can resume you, reply to the user now; this tool will keep your turn open. Return completed work normally. Does not message other sessions. Omit waitFor when yielding for your own children. Set waitFor:"message" only for an active subagent task waiting for its requester, not a new human conversation in a kept child session. For background tools, follow their continuation instructions. Automation turns end here; the scheduler delivers child output under the job delivery policy. Collector runs require explicit collection instead.',
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
        if (acknowledgment && hasResumingPendingChild(claim.pendingChildren)) {
          // Keep the existing wake owner; only end this turn with its waiting reply.
          await opts.onYield(message, acknowledgment, undefined);
          return jsonResult({
            status: "yielded",
            acknowledgment,
            pendingChildren: claim.pendingChildren,
          });
        }
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
              ? `No active native task registered this message wait. ${NO_PENDING_CHILD_COMPLETION_MESSAGE}`
              : NO_PENDING_CHILD_COMPLETION_MESSAGE,
        });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      const messageWaitRegistered =
        typeof claim === "object" && "messageWaitRegistered" in claim
          ? claim.messageWaitRegistered
          : undefined;
      await (typeof claim === "object" && "resumesInPlace" in claim
        ? opts.onYield(message, acknowledgment, messageWaitRegistered, { resumesInPlace: true })
        : opts.onYield(message, acknowledgment, messageWaitRegistered));
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
