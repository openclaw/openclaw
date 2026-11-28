// Prints a Gateway agent reply. A turn that yields to its subagents ends before its
// answer exists, so the CLI keeps the agent connection open for the session's follow-up.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  hasCompletionMessageSessionSpawn,
  type AcceptedSessionSpawn,
} from "../agents/accepted-session-spawn.js";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent-runner/types.js";
import type { ProgressReporter } from "../cli/progress.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

export type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  reason?: string;
  pendingInputId?: string;
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
    deliveryStatus?: unknown;
    meta?: EmbeddedAgentRunMeta;
    acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  };
  deliveryStatus?: unknown;
};

function formatInFlightGatewayAgentMessage(response: GatewayAgentResponse): string {
  return response.runId
    ? `Agent run ${response.runId} is already in flight; not starting a duplicate run.`
    : "Agent run is already in flight; not starting a duplicate run.";
}

export function readAcceptedRunContext(payload: unknown) {
  const accepted = asOptionalRecord(payload);
  if (accepted?.status !== "accepted") {
    return undefined;
  }
  return {
    runId: normalizeOptionalString(accepted.runId),
    sessionKey: normalizeOptionalString(accepted.sessionKey),
    agentId: normalizeOptionalString(accepted.agentId),
  };
}

async function printGatewayAgentReply(
  reply: GatewayAgentResponse,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  if (opts.json) {
    const deliveryStatus = reply.result?.deliveryStatus;
    writeRuntimeJson(runtime, deliveryStatus === undefined ? reply : { ...reply, deliveryStatus });
    return;
  }
  const payloads = reply.result?.payloads ?? [];
  if (reply.result?.meta?.requestShaping?.thinkingClamp) {
    runtime.log(reply.result.meta.requestShaping.thinkingClamp);
  }
  if (reply.reason === "input_withdrawn_before_turn") {
    runtime.error?.(reply.summary);
    return;
  }
  if (reply.status === "in_flight") {
    runtime.error?.(formatInFlightGatewayAgentMessage(reply));
    return;
  }
  if (payloads.length === 0) {
    // A yielded turn's own acknowledgment is its reply until the follow-up answers.
    const acknowledgment = reply.result?.meta?.yieldAcknowledgment?.trim();
    if (reply.status !== "ok") {
      runtime.log(reply.summary ? reply.summary : "No reply from agent.");
    } else if (acknowledgment) {
      runtime.log(acknowledgment);
    }
    return;
  }
  for (const payload of payloads) {
    // Lazy: plain CLI startup must not load outbound formatting.
    const { resolveSendableOutboundReplyParts } = await import("openclaw/plugin-sdk/reply-payload");
    const { formatOutboundPayloadLog } = await import("../infra/outbound/payloads.js");
    const parts = resolveSendableOutboundReplyParts({
      text: payload.text,
      mediaUrls: payload.mediaUrls,
      mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
    });
    const out = formatOutboundPayloadLog(parts).trimEnd();
    if (out) {
      runtime.log(out);
    }
  }
}

type YieldFollowUp =
  | { kind: "reply"; text?: string }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" }
  | { kind: "disconnected" };

function messageText(message: unknown): string | undefined {
  return (
    extractTextFromChatContent(asOptionalRecord(message)?.content, {
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? undefined
  );
}

/**
 * The agent connection is an unscoped session-event audience (no `session-scoped-events`
 * cap; see server-broadcast.transport.test.ts "visits only the session audience"), so it
 * already receives `agent` lifecycle and `chat` events for the session and its children.
 * They are observed from the first frame: no subscription, no gap before the yield.
 * Session runs are serialized, so the follow-up is the first run that starts in the session
 * after one of the turn's children ends. Accepted edge: another turn (heartbeat, inbound
 * message) starting in that idle window, or after a follow-up that yields again, is taken
 * for the follow-up. Exact matching needs the settle run id, which the protocol does not carry.
 */
export function createYieldFollower(params: {
  json?: boolean;
  timeoutSeconds: number;
  runtime: RuntimeEnv;
}) {
  const { json, timeoutSeconds, runtime } = params;
  const buffered: EventFrame[] = [];
  let observe: ((event: EventFrame) => void) | undefined;
  let printed = false;
  let outcome: YieldFollowUp | undefined;
  const follower = {
    /** The yielded turn whose follow-up the connection is waiting for. */
    following: undefined as GatewayAgentResponse | undefined,
    onEvent(event: EventFrame) {
      const payload = asOptionalRecord(event.payload);
      const relevant =
        (event.event === "agent" && payload?.stream === "lifecycle") ||
        (event.event === "chat" && payload?.state !== "delta");
      if (json || !relevant) {
        return;
      }
      if (observe) {
        observe(event);
      } else {
        buffered.push(event);
      }
    },
    /** Resolves once the follow-up replies, fails, times out or the connection closes. */
    async follow(input: {
      response: GatewayAgentResponse;
      sessionKey: string | undefined;
      connection: AbortSignal;
      progress: ProgressReporter;
    }): Promise<void> {
      const { response } = input;
      const spawns = response.result?.acceptedSessionSpawns;
      if (
        json ||
        !input.sessionKey ||
        !response.runId ||
        response.result?.meta?.yielded !== true ||
        !hasCompletionMessageSessionSpawn(spawns)
      ) {
        buffered.length = 0;
        return;
      }
      const children = new Set(
        spawns?.filter((spawn) => spawn.expectsCompletionMessage).map((spawn) => spawn.runId),
      );
      follower.following = response;
      printed = true;
      await printGatewayAgentReply(response, {}, runtime);
      input.progress.setLabel(
        `Waiting on ${children.size === 1 ? "1 subagent" : `${children.size} subagents`}…`,
      );
      const done = Promise.withResolvers<YieldFollowUp>();
      let childEnded = false;
      let followUpRunId: string | undefined;
      observe = (event) => {
        const payload = asOptionalRecord(event.payload);
        const runId = payload?.runId;
        if (typeof runId !== "string") {
          return;
        }
        const phase = asOptionalRecord(payload?.data)?.phase;
        if (event.event === "agent" && payload?.stream === "lifecycle") {
          if (children.has(runId) && (phase === "end" || phase === "error")) {
            childEnded = true;
          } else if (
            phase === "start" &&
            childEnded &&
            !followUpRunId &&
            runId !== response.runId &&
            payload.sessionKey === input.sessionKey
          ) {
            followUpRunId = runId;
          }
          return;
        }
        if (event.event !== "chat" || runId !== followUpRunId) {
          return;
        }
        if (payload?.state === "final") {
          if (payload.yielded === true) {
            followUpRunId = undefined;
          } else {
            done.resolve({ kind: "reply", text: messageText(payload.message) });
          }
        } else if (payload?.state === "error" || payload?.state === "aborted") {
          const reason = payload.errorMessage;
          done.resolve({
            kind: "failed",
            reason:
              typeof reason === "string" && reason ? reason : `the follow-up was ${payload.state}`,
          });
        }
      };
      for (const event of buffered.splice(0)) {
        observe(event);
      }
      // `--timeout 0` disables the turn's deadline, and so the wait's.
      if (timeoutSeconds > 0) {
        const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
        deadline.addEventListener("abort", () => done.resolve({ kind: "timeout" }), { once: true });
      }
      input.connection.addEventListener("abort", () => done.resolve({ kind: "disconnected" }), {
        once: true,
      });
      // The connection can close while the turn's own reply prints.
      if (input.connection.aborted) {
        done.resolve({ kind: "disconnected" });
      }
      outcome = await done.promise;
    },
    /** Prints the turn's reply, then the follow-up; a wait that ends early says where the result goes. */
    async finish(response: GatewayAgentResponse, sessionKey: string | undefined): Promise<void> {
      if (!printed) {
        await printGatewayAgentReply(response, { json }, runtime);
      }
      if (!outcome) {
        return;
      }
      if (outcome.kind === "reply") {
        if (outcome.text) {
          runtime.log(outcome.text);
        }
        return;
      }
      const where = sessionKey ? `session ${sessionKey}` : "the session";
      runtime.error?.(
        outcome.kind === "failed"
          ? `The follow-up reply failed: ${outcome.reason}`
          : outcome.kind === "timeout"
            ? `Stopped waiting after ${timeoutSeconds}s. The subagents' result will be added to ${where}.`
            : `Stopped waiting for the subagents. Their result will still be added to ${where}.`,
      );
      process.exitCode = 1;
    },
  };
  return follower;
}
