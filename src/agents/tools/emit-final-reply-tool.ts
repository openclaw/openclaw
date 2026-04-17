// Phase 9 P3 Discord Surface Overhaul: agent-callable `emit_final_reply` tool.
//
// Lets any agent (within its own session) explicitly declare a final reply.
// This is an escape hatch for cases where the normal classifier would tag the
// message as `progress` or `internal_narration` but the agent knows the turn
// is actually terminal. NOT ownerOnly — the agent can only speak for its own
// session.

import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordReceipt } from "../../infra/outbound/delivery-receipts.js";
import { sendMessage } from "../../infra/outbound/message.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { planDelivery } from "../../infra/outbound/surface-policy.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";

const EmitFinalReplyToolSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
});

/**
 * Resolve a delivery context for the caller's own session. Prefers the
 * explicit agentChannel/agentTo/agentThreadId wired into the tool (matches
 * how other tools get their inbound context), and falls back to the session
 * binding service if those are unset.
 */
function resolveCallerDeliveryContext(opts?: {
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentSessionKey?: string;
}): DeliveryContext | undefined {
  const direct = normalizeDeliveryContext({
    channel: opts?.agentChannel,
    to: opts?.agentTo,
    accountId: opts?.agentAccountId,
    threadId: opts?.agentThreadId,
  });
  if (direct?.channel && direct?.to) {
    return direct;
  }
  const sessionKey = opts?.agentSessionKey;
  if (!sessionKey) {
    return direct;
  }
  // Fall back to active bindings for this session.
  const bindings = getSessionBindingService().listBySession(sessionKey);
  for (const binding of bindings) {
    if (binding.status !== "active") {
      continue;
    }
    const conversation = binding.conversation;
    const resolved = normalizeDeliveryContext({
      channel: conversation.channel,
      to: conversation.conversationId ? `channel:${conversation.conversationId}` : undefined,
      accountId: conversation.accountId,
      threadId: conversation.parentConversationId ? conversation.conversationId : undefined,
    });
    if (resolved?.channel && resolved?.to) {
      return resolved;
    }
  }
  return direct;
}

export function createEmitFinalReplyTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Emit Final Reply",
    name: "emit_final_reply",
    description:
      "Explicitly deliver a final reply for this session, bypassing classification. Use when the normal classifier would mark the turn as progress/internal.",
    parameters: EmitFinalReplyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const { effectiveRequesterKey } = resolveSessionToolContext(opts);
      const sessionKey = effectiveRequesterKey;
      if (!sessionKey) {
        return jsonResult({
          status: "error",
          error: "No session context for emit_final_reply",
        });
      }

      const ctx = resolveCallerDeliveryContext(opts);
      const resolvedContextAt = Date.now();
      const messageClass = "final_reply" as const;

      const plan = planDelivery({
        messageClass,
        surface: ctx ?? { channel: "", to: "" },
      });

      const target =
        ctx?.channel && ctx?.to
          ? {
              channel: ctx.channel,
              to: ctx.to,
              ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
              ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
            }
          : { channel: "unknown", to: "unknown" };

      if (plan.outcome === "suppress") {
        recordReceipt(sessionKey, {
          target,
          messageClass,
          outcome: "suppressed",
          reason: `agent_explicit_override:${plan.reason}`,
          ts: Date.now(),
          resolvedContextAt,
        });
        return jsonResult({
          status: "suppressed",
          reason: plan.reason,
          sessionKey,
        });
      }

      const threadBound = Boolean(ctx?.threadId);
      let messageId: string | undefined;
      let mode: "direct" | "queued";
      if (threadBound && ctx?.channel && ctx?.to) {
        try {
          const result = await sendMessage({
            channel: ctx.channel,
            to: ctx.to,
            content: text,
            ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
            ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
            messageClass,
            bestEffort: true,
          });
          const rawId = (result?.result as { messageId?: unknown } | undefined)?.messageId;
          if (typeof rawId === "string" && rawId) {
            messageId = rawId;
          }
          mode = "direct";
        } catch (err) {
          return jsonResult({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            sessionKey,
          });
        }
      } else {
        enqueueSystemEvent(text, {
          sessionKey,
          contextKey: "emit_final_reply",
          deliveryContext: ctx,
          messageClass,
          trusted: false,
        });
        mode = "queued";
      }

      recordReceipt(sessionKey, {
        target,
        ...(messageId ? { messageId } : {}),
        messageClass,
        outcome: "delivered",
        reason: "agent_explicit_override",
        ts: Date.now(),
        resolvedContextAt,
      });

      return jsonResult({
        status: "ok",
        mode,
        sessionKey,
        ...(messageId ? { messageId } : {}),
        runId: crypto.randomUUID(),
      });
    },
  };
}
