import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { writeFileWithinRoot } from "../../infra/fs-safe.js";
import { listActivityLogs } from "../../orchestration/activity-log-sqlite.js";
import {
  getAgentConfigRevision,
  listAgentConfigRevisions,
  createAgentConfigRevision,
} from "../../orchestration/agent-config-revision-sqlite.js";
import {
  requestApproval,
  getApproval,
  listApprovals,
  decideApproval,
  updateApprovalPayload,
  addApprovalComment,
  listApprovalComments,
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
  ApprovalsCommentsListParams,
  ApprovalsCommentsAddParams,
  AgentConfigRevisionsRollbackParams,
} from "../protocol/schema/types.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Parse the original filename from a changeNote like "Updated SOUL.md via gateway". */
function parseFileNameFromChangeNote(changeNote: string | null): string | null {
  if (!changeNote) {
    return null;
  }
  const m = changeNote.match(/^(?:Updated|Created)\s+(\S+)\s+via gateway$/);
  return m ? m[1] : null;
}

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

  // ── Agent Config Revision Rollback ─────────────────────────────────────────
  "revisions.config.rollback": async ({ params, respond }) => {
    try {
      const p = params as unknown as AgentConfigRevisionsRollbackParams;
      const revision = getAgentConfigRevision(p.revisionId);
      if (!revision) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Revision not found: ${p.revisionId}`),
        );
        return;
      }

      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, revision.agentId);

      // Resolve the target filename from changeNote; fall back to SOUL.md.
      const fileName = parseFileNameFromChangeNote(revision.changeNote) ?? "SOUL.md";
      const workspaceReal = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
      const relativePath = fileName;

      await writeFileWithinRoot({
        rootDir: workspaceReal,
        relativePath,
        data: revision.configJson,
        encoding: "utf8",
      });

      // Record the rollback itself as a new revision for auditability.
      createAgentConfigRevision({
        workspaceId: revision.workspaceId,
        agentId: revision.agentId,
        config: revision.configJson,
        changedBy: "system",
        changeNote: `Rolled back to revision ${revision.id} (${fileName})`,
      });

      respond(true, { ok: true, revisionId: revision.id, agentId: revision.agentId });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  // ── Approval Comments ──────────────────────────────────────────────────────
  "approvals.comments.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsCommentsListParams;
      const comments = listApprovalComments(p.approvalId);
      respond(true, { comments });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "approvals.comments.add": async ({ params, respond }) => {
    try {
      const p = params as unknown as ApprovalsCommentsAddParams;
      const comment = addApprovalComment({
        approvalId: p.approvalId,
        authorId: p.authorId,
        authorType: p.authorType,
        body: p.body,
      });
      respond(true, comment);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
