// Phase 9 P4 Discord Surface Overhaul: owner-only `resume_for_task` tool.
//
// Operator escape-hatch to resume a paused/interrupted task by pushing a
// control message into its bound surface. Phase 4 REWORK (origin-respect
// routing): there is no longer an "operator channel" — the message MUST go
// to the surface that originated the task (its binding).
//
// Fail-closed guard sequence (in order):
//   1. Task exists.
//   2. Task has a sessionKey (child or requester).
//   3. Session has at least one `active` binding with `conversationId`.
//   4. Task derives as "paused/interrupted": status ∈ {running, queued, lost}
//      AND hasBackingSession(task) === false. This derives the paused state
//      without adding a new TaskStatus enum value (Option B in the design).
//   5. Deliver via `sendMessage(messageClass: "resume")` to the bound surface.
//      If the derived delivery context has no origin, suppress.

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordReceipt } from "../../infra/outbound/delivery-receipts.js";
import { sendMessage } from "../../infra/outbound/message.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { planDelivery } from "../../infra/outbound/surface-policy.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { hasBackingSession } from "../../tasks/task-registry.maintenance.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ResumeForTaskToolSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
});

function isActiveBinding(record: SessionBindingRecord): boolean {
  return record.status === "active";
}

function pickDeliveryContextFromBinding(
  binding: SessionBindingRecord,
): DeliveryContext | undefined {
  const conversation = binding.conversation;
  if (!conversation?.channel || !conversation?.conversationId) {
    return undefined;
  }
  const parentId = conversation.parentConversationId;
  const isThreadChild = parentId && parentId !== conversation.conversationId;
  const to = isThreadChild ? `channel:${parentId}` : `channel:${conversation.conversationId}`;
  const ctx: DeliveryContext = {
    channel: conversation.channel,
    to,
    ...(conversation.accountId ? { accountId: conversation.accountId } : {}),
    ...(isThreadChild ? { threadId: conversation.conversationId } : {}),
  };
  return ctx;
}

export function createResumeForTaskTool(_opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Resume For Task",
    name: "resume_for_task",
    description:
      "Operator escape-hatch: resume a paused/interrupted task by delivering a resume message to its bound surface.",
    parameters: ResumeForTaskToolSchema,
    ownerOnly: true,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const taskId = readStringParam(params, "taskId", { required: true });
      const message = readStringParam(params, "message", { required: true });

      // 1. Task exists.
      const task = getTaskById(taskId);
      if (!task) {
        return jsonResult({
          status: "not_found",
          error: `No task found: ${taskId}`,
        });
      }

      // 2. Resolve a session key.
      const sessionKey = task.childSessionKey?.trim() || task.requesterSessionKey?.trim() || "";
      if (!sessionKey) {
        return jsonResult({
          status: "error",
          error: "Task has no sessionKey (no child or requester session).",
          taskId,
        });
      }

      // 3. At least one active binding.
      const bindings = getSessionBindingService()
        .listBySession(sessionKey)
        .filter(isActiveBinding)
        .filter((b) => Boolean(b.conversation?.conversationId?.trim()));
      if (bindings.length === 0) {
        return jsonResult({
          status: "no_binding",
          error: "Task session has no active binding with a concrete conversationId.",
          taskId,
          sessionKey,
        });
      }

      // 4. Task derives as paused/interrupted.
      //    Active statuses: running/queued/lost. Also require: no backing session.
      const activeStatuses = new Set(["running", "queued", "lost"]);
      if (!activeStatuses.has(task.status)) {
        return jsonResult({
          status: "bad_state",
          error: `Task status "${task.status}" is terminal; cannot resume.`,
          taskId,
        });
      }
      const hasBacking = hasBackingSession(task);
      if (hasBacking) {
        return jsonResult({
          status: "bad_state",
          error: "Task still has a live backing session; resume is a no-op.",
          taskId,
        });
      }

      // 5. Deliver to the bound surface directly. Phase 4 rework — NO operator
      //    channel reroute. If a binding's derived context has no origin,
      //    suppress consistently with origin-respect semantics.
      const binding = bindings[0];
      if (!binding) {
        return jsonResult({
          status: "no_binding",
          error: "Binding vanished between guard and delivery.",
          taskId,
          sessionKey,
        });
      }
      const deliveryContext = pickDeliveryContextFromBinding(binding);
      const resolvedContextAt = Date.now();
      const messageClass = "resume" as const;
      const plan = planDelivery({
        messageClass,
        surface: deliveryContext ?? { channel: "", to: "" },
      });
      const target =
        deliveryContext?.channel && deliveryContext?.to
          ? {
              channel: deliveryContext.channel,
              to: deliveryContext.to,
              ...(deliveryContext.accountId ? { accountId: deliveryContext.accountId } : {}),
              ...(deliveryContext.threadId != null ? { threadId: deliveryContext.threadId } : {}),
            }
          : { channel: "unknown", to: "unknown" };
      if (plan.outcome === "suppress") {
        recordReceipt(sessionKey, {
          target,
          messageClass,
          outcome: "suppressed",
          reason: `operator_resume_escape_hatch:${plan.reason}`,
          ts: Date.now(),
          resolvedContextAt,
        });
        return jsonResult({
          status: "suppressed",
          reason: plan.reason,
          taskId,
          sessionKey,
        });
      }

      if (!deliveryContext?.channel || !deliveryContext?.to) {
        // Defensive: planDelivery should have suppressed this already.
        return jsonResult({
          status: "suppressed",
          reason: "no_origin",
          taskId,
          sessionKey,
        });
      }

      try {
        const result = await sendMessage({
          channel: deliveryContext.channel,
          to: deliveryContext.to,
          content: message,
          ...(deliveryContext.accountId ? { accountId: deliveryContext.accountId } : {}),
          ...(deliveryContext.threadId != null ? { threadId: deliveryContext.threadId } : {}),
          messageClass,
          bestEffort: true,
        });
        const messageId = (result?.result as { messageId?: unknown } | undefined)?.messageId;
        recordReceipt(sessionKey, {
          target,
          ...(typeof messageId === "string" && messageId ? { messageId } : {}),
          messageClass,
          outcome: "delivered",
          reason: "operator_resume_escape_hatch",
          ts: Date.now(),
          resolvedContextAt,
        });
        return jsonResult({
          status: "ok",
          taskId,
          sessionKey,
          ...(typeof messageId === "string" && messageId ? { messageId } : {}),
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          taskId,
          sessionKey,
        });
      }
    },
  };
}
