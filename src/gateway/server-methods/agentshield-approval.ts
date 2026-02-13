import type { AgentShieldApprovalForwarder } from "../../infra/agentshield-approval-forwarder.js";
import type { AgentShieldRetryStore } from "../../infra/agentshield-retry-store.js";
import type {
  AgentShieldApprovalDecision,
  AgentShieldApprovalManager,
} from "../agentshield-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentShieldApprovalRequestParams,
  validateAgentShieldApprovalResolveParams,
  validateAgentShieldApprovalListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export type { AgentShieldApprovalDecision } from "../agentshield-approval-manager.js";

export function createAgentShieldApprovalHandlers(
  manager: AgentShieldApprovalManager,
  opts?: {
    forwarder?: AgentShieldApprovalForwarder;
    retryStore?: AgentShieldRetryStore;
  },
): GatewayRequestHandlers {
  return {
    "agentshield.approval.request": async ({ params, respond, context }) => {
      if (!validateAgentShieldApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agentshield.approval.request params: ${formatValidationErrors(
              validateAgentShieldApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        toolName: string;
        paramsJSON: string;
        agentId?: string;
        sessionKey?: string;
        timeoutMs?: number;
      };
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120_000;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }

      const record = manager.create(
        {
          toolName: p.toolName,
          paramsJSON: p.paramsJSON,
          agentId: p.agentId ?? null,
          sessionKey: p.sessionKey ?? null,
        },
        timeoutMs,
        explicitId,
      );

      // Store encrypted args for later retry (never logged).
      opts?.retryStore?.store(record.id, p.toolName, p.paramsJSON, {
        agentId: record.agentId,
        sessionKey: record.sessionKey,
      });

      const decisionPromise = manager.waitForDecision(record, timeoutMs);

      // Broadcast to all connected clients.
      context.broadcast(
        "agentshield.approval.requested",
        {
          id: record.id,
          toolName: record.toolName,
          argsFingerprint: record.argsFingerprint,
          agentId: record.agentId,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );

      // Forward to configured targets (never raw args).
      void opts?.forwarder
        ?.handleRequested({
          id: record.id,
          toolName: record.toolName,
          argsFingerprint: record.argsFingerprint,
          agentId: record.agentId,
          sessionKey: record.sessionKey,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })
        .catch((err) => {
          context.logGateway?.error?.(
            `agentshield approvals: forward request failed: ${String(err)}`,
          );
        });

      const decision = await decisionPromise;

      respond(
        true,
        {
          id: record.id,
          decision,
          argsFingerprint: record.argsFingerprint,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },

    "agentshield.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateAgentShieldApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agentshield.approval.resolve params: ${formatValidationErrors(
              validateAgentShieldApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as AgentShieldApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(p.id, decision, resolvedBy ?? null);
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }
      context.broadcast(
        "agentshield.approval.resolved",
        { id: p.id, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({ id: p.id, decision, resolvedBy, ts: Date.now() })
        .catch((err) => {
          context.logGateway?.error?.(
            `agentshield approvals: forward resolve failed: ${String(err)}`,
          );
        });
      respond(true, { ok: true }, undefined);
    },

    "agentshield.approval.list": ({ params, respond }) => {
      if (!validateAgentShieldApprovalListParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agentshield.approval.list params: ${formatValidationErrors(
              validateAgentShieldApprovalListParams.errors,
            )}`,
          ),
        );
        return;
      }
      const pending = manager.listPending();
      // Return only fingerprints, never raw args.
      const entries = pending.map((r) => ({
        id: r.id,
        toolName: r.toolName,
        argsFingerprint: r.argsFingerprint,
        agentId: r.agentId,
        createdAtMs: r.createdAtMs,
        expiresAtMs: r.expiresAtMs,
      }));
      respond(true, { entries }, undefined);
    },
  };
}
