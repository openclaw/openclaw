import { randomUUID } from "node:crypto";
import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const APPROVAL_NOT_FOUND_DETAILS = {
  reason: ErrorCodes.APPROVAL_NOT_FOUND,
} as const;

export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      if (!validatePluginApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = Math.min(
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
        MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
      );

      const normalizeTrimmedString = (value?: string | null): string | null =>
        value?.trim() || null;

      const request: PluginApprovalRequestPayload = {
        pluginId: p.pluginId ?? null,
        title: p.title,
        description: p.description,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);

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
        "plugin.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );

      let forwarded = false;
      if (opts?.forwarder?.handlePluginApprovalRequested) {
        try {
          forwarded = await opts.forwarder.handlePluginApprovalRequested({
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          });
        } catch (err) {
          context.logGateway?.error?.(`plugin approvals: forward request failed: ${String(err)}`);
        }
      }

      const hasApprovalClients = context.hasExecApprovalClients?.(client?.connId) ?? false;
      const hasTurnSourceRoute = hasApprovalTurnSourceRoute({
        turnSourceChannel: record.request.turnSourceChannel,
      });
      if (!hasApprovalClients && !forwarded && !hasTurnSourceRoute) {
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

    "plugin.approval.waitDecision": async ({ params, respond }) => {
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

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validatePluginApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.resolve params: ${formatValidationErrors(
              validatePluginApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as ExecApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const approvalId = p.id.trim();
      const snapshot = manager.getSnapshot(approvalId);
      if (!snapshot || snapshot.resolvedAtMs !== undefined) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
            details: APPROVAL_NOT_FOUND_DETAILS,
          }),
        );
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(approvalId, decision, resolvedBy ?? null);
      if (!ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
            details: APPROVAL_NOT_FOUND_DETAILS,
          }),
        );
        return;
      }
      context.broadcast(
        "plugin.approval.resolved",
        { id: approvalId, decision, resolvedBy, ts: Date.now(), request: snapshot?.request },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handlePluginApprovalResolved?.({
          id: approvalId,
          decision,
          resolvedBy,
          ts: Date.now(),
          request: snapshot?.request,
        })
        .catch((err) => {
          context.logGateway?.error?.(`plugin approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
