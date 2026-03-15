/**
 * Gateway server methods for MCP/plugin tool approval requests.
 *
 * Reuses the ExecApprovalManager for pending request tracking since the
 * approval lifecycle (request, wait, resolve) is identical. The only
 * difference is the event names and the payload shape.
 */

import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import {
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  type ToolApprovalRequestPayload,
} from "../../infra/tool-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createToolApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "tool.approval.request": async ({ params, respond, context, client }) => {
      const p = params as {
        id?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        agentId?: string;
        sessionKey?: string;
        turnSourceChannel?: string;
        turnSourceTo?: string;
        turnSourceAccountId?: string;
        turnSourceThreadId?: string | number;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_TOOL_APPROVAL_TIMEOUT_MS;
      const toolName = typeof p.toolName === "string" ? p.toolName.trim() : "";
      if (!toolName) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "toolName is required"));
        return;
      }
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }

      const request: ToolApprovalRequestPayload = {
        toolName,
        args: p.args ?? null,
        agentId: typeof p.agentId === "string" ? p.agentId.trim() || null : null,
        sessionKey: typeof p.sessionKey === "string" ? p.sessionKey.trim() || null : null,
        host: "gateway",
        security: null,
        ask: null,
        turnSourceChannel:
          typeof p.turnSourceChannel === "string" ? p.turnSourceChannel.trim() || null : null,
        turnSourceTo: typeof p.turnSourceTo === "string" ? p.turnSourceTo.trim() || null : null,
        turnSourceAccountId:
          typeof p.turnSourceAccountId === "string" ? p.turnSourceAccountId.trim() || null : null,
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Reuse ExecApprovalManager by converting the tool payload to the
      // format expected by the manager. The manager only cares about `command`
      // for display purposes, so we pass the tool name as the command field.
      const record = manager.create(
        {
          command: toolName,
          commandPreview: `tool: ${toolName}`,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          host: request.host,
          security: request.security,
          ask: request.ask,
          turnSourceChannel: request.turnSourceChannel,
          turnSourceTo: request.turnSourceTo,
          turnSourceAccountId: request.turnSourceAccountId,
          turnSourceThreadId: request.turnSourceThreadId,
        },
        timeoutMs,
        explicitId,
      );
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;

      let decisionPromise: Promise<ExecApprovalDecision | null>;
      try {
        decisionPromise = manager.register(record, timeoutMs);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }

      context.broadcast(
        "tool.approval.requested",
        {
          id: record.id,
          request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );

      const hasApprovalClients = context.hasExecApprovalClients?.() ?? false;
      let forwarded = false;
      if (opts?.forwarder) {
        try {
          forwarded = await opts.forwarder.handleRequested({
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          });
        } catch (err) {
          context.logGateway?.error?.(`tool approvals: forward request failed: ${String(err)}`);
        }
      }

      if (!hasApprovalClients && !forwarded) {
        manager.expire(record.id, "no-approval-route");
        respond(
          true,
          {
            id: record.id,
            decision: null,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
        return;
      }

      if (twoPhase) {
        respond(
          true,
          {
            status: "accepted",
            id: record.id,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
      }

      const decision = await decisionPromise;
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },

    "tool.approval.waitDecision": async ({ params, respond }) => {
      const p = params as { id?: string };
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const decisionPromise = manager.awaitDecision(id);
      if (!decisionPromise) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
        );
        return;
      }
      const snapshot = manager.getSnapshot(id);
      const decision = await decisionPromise;
      respond(
        true,
        {
          id,
          decision,
          createdAtMs: snapshot?.createdAtMs,
          expiresAtMs: snapshot?.expiresAtMs,
        },
        undefined,
      );
    },

    "tool.approval.resolve": async ({ params, respond, client, context }) => {
      const p = params as { id?: string; decision?: string };
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const decision = typeof p.decision === "string" ? p.decision.trim() : "";
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedId = manager.lookupPendingId(id);
      if (resolvedId.kind === "none") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"),
        );
        return;
      }
      if (resolvedId.kind === "ambiguous") {
        const candidates = resolvedId.ids.slice(0, 3).join(", ");
        const remainder = resolvedId.ids.length > 3 ? ` (+${resolvedId.ids.length - 3} more)` : "";
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `ambiguous approval id prefix; matches: ${candidates}${remainder}. Use the full id.`,
          ),
        );
        return;
      }
      const approvalId = resolvedId.id;
      const snapshot = manager.getSnapshot(approvalId);
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(approvalId, decision as ExecApprovalDecision, resolvedBy ?? null);
      if (!ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"),
        );
        return;
      }
      context.broadcast(
        "tool.approval.resolved",
        { id: approvalId, decision, resolvedBy, ts: Date.now(), request: snapshot?.request },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({
          id: approvalId,
          decision,
          resolvedBy,
          ts: Date.now(),
          request: snapshot?.request,
        })
        .catch((err) => {
          context.logGateway?.error?.(`tool approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
