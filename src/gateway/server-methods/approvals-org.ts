import { listActivityLogs } from "../../orchestration/activity-log-sqlite.js";
import {
  getAgentConfigRevision,
  listAgentConfigRevisions,
} from "../../orchestration/agent-config-revision-sqlite.js";
import {
  requestApproval,
  getApproval,
  listApprovals,
  decideApproval,
  updateApprovalPayload,
} from "../../orchestration/approval-store-sqlite.js";
import type { ApprovalStatus, ApprovalType } from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type {
  ApprovalsListParams,
  ApprovalsGetParams,
  ApprovalsCreateParams,
  ApprovalsUpdatePayloadParams,
  ApprovalsDecideParams,
  ActivityLogsListParams,
  AgentConfigRevisionsListParams,
  AgentConfigRevisionsGetParams,
} from "../protocol/schema/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const approvalsHandlers: GatewayRequestHandlers = {
  // ── Approvals ─────────────────────────────────────────────────────────────
  "approvals.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsListParams;
      const approvals = listApprovals({
        workspaceId: p.workspaceId,
        status: p.status as ApprovalStatus | undefined,
        type: p.type as ApprovalType | undefined,
      });
      respond(true, { approvals });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "approvals.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsGetParams;
      const approval = getApproval(p.id);
      if (!approval) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Approval not found: ${p.id}`),
        );
        return;
      }
      respond(true, approval);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "approvals.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsCreateParams;
      const approval = requestApproval({
        workspaceId: p.workspaceId,
        type: p.type as ApprovalType,
        requesterId: p.requesterId,
        requesterType: p.requesterType,
        payload: p.payload,
      });
      respond(true, approval);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "approvals.updatePayload": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsUpdatePayloadParams;
      const approval = updateApprovalPayload(p.id, p.payload);
      respond(true, approval);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "approvals.decide": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsDecideParams;
      const approval = decideApproval(p.id, p.decision, p.decidedBy, p.decisionNote);
      respond(true, approval);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes("not found") || err.message.includes("Cannot decide"))
      ) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  // ── Activity Logs ──────────────────────────────────────────────────────────
  "activityLogs.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as ActivityLogsListParams;
      const logs = listActivityLogs({
        workspaceId: p.workspaceId,
        entityType: p.entityType,
        entityId: p.entityId,
        actorId: p.actorId,
        limit: p.limit,
        offset: p.offset,
      });
      respond(true, { logs });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  // ── Agent Config Revisions ────────────────────────────────────────────────
  "revisions.config.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as AgentConfigRevisionsListParams;
      const revisions = listAgentConfigRevisions({
        workspaceId: p.workspaceId,
        agentId: p.agentId,
      });
      respond(true, { revisions });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "revisions.config.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as AgentConfigRevisionsGetParams;
      const revision = getAgentConfigRevision(p.id);
      if (!revision) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Revision not found: ${p.id}`),
        );
        return;
      }
      respond(true, revision);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
