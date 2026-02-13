/**
 * sessions_broadcast — broadcast a message to all sessions bound to a thread.
 *
 * A convenience wrapper around the thread-registry + gateway agent call.
 * Looks up all sessions bound to a threadKey and sends the message to each
 * in parallel.
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "./common.js";
import { findSessionsByThread, parseThreadKey } from "../../config/thread-registry.js";
import { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsBroadcastToolSchema = Type.Object({
  threadKey: Type.String({
    description:
      "Thread key (format: channel:accountId:threadId). Message will be sent to all sessions bound to this thread.",
  }),
  message: Type.String({ description: "Message to broadcast to all bound sessions." }),
});

export function createSessionsBroadcastTool(): AnyAgentTool {
  return {
    label: "Session Broadcast",
    name: "sessions_broadcast",
    description:
      "Broadcast a message to all sessions bound to a thread. Uses threadKey (channel:accountId:threadId) to look up bound sessions and sends the message to each in parallel.",
    parameters: SessionsBroadcastToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const threadKey = readStringParam(params, "threadKey", { required: true });
      const message = readStringParam(params, "message", { required: true });

      const parsed = parseThreadKey(threadKey);
      if (!parsed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `Invalid threadKey format: ${threadKey}. Expected channel:accountId:threadId`,
        });
      }

      const boundSessions = findSessionsByThread(parsed);
      if (boundSessions.length === 0) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `No sessions bound to thread: ${threadKey}`,
        });
      }

      // Parallel fanout to all bound sessions.
      const results = await Promise.allSettled(
        boundSessions.map(async (targetKey) => {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message,
              sessionKey: targetKey,
              idempotencyKey: crypto.randomUUID(),
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_NESTED,
            },
            timeoutMs: 10_000,
          });
          return {
            sessionKey: targetKey,
            runId: typeof response?.runId === "string" ? response.runId : undefined,
          };
        }),
      );

      const sent: Array<{ sessionKey: string; runId?: string }> = [];
      const failed: Array<{ sessionKey: string; error: string }> = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          sent.push(r.value);
        } else {
          failed.push({
            sessionKey: "unknown",
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }

      return jsonResult({
        runId: crypto.randomUUID(),
        status: failed.length === 0 ? "ok" : sent.length > 0 ? "partial" : "error",
        threadKey,
        sessionCount: boundSessions.length,
        sent,
        failed: failed.length > 0 ? failed : undefined,
      });
    },
  };
}
