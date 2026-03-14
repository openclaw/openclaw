import {
  ensureExecApprovals,
  getTrustWindow,
  grantTrustWindow,
  isTrustWindowActive,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  normalizeExecApprovalAgentId,
  readExecApprovalsSnapshot,
  revokeTrustWindow,
  saveExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import { cleanupTrustAudit } from "../../infra/trust-audit.js";
import {
  ErrorCodes,
  errorShape,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
  validateExecApprovalsTrustParams,
  validateExecApprovalsTrustStatusParams,
  validateExecApprovalsUntrustParams,
} from "../protocol/index.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireApprovalsBaseHash(
  params: unknown,
  snapshot: ExecApprovalsSnapshot,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals base hash unavailable; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals base hash required; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals changed since last load; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function toExecApprovalsPayload(snapshot: ExecApprovalsSnapshot) {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: redactExecApprovals(snapshot.file),
  };
}

function resolveNodeIdOrRespond(nodeId: string, respond: RespondFn): string | null {
  const id = nodeId.trim();
  if (!id) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
    return null;
  }
  return id;
}

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) {
      return;
    }
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();
    respond(true, toExecApprovalsPayload(snapshot), undefined);
  },
  "exec.approvals.set": ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) {
      return;
    }
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();
    if (!requireApprovalsBaseHash(params, snapshot, respond)) {
      return;
    }
    const incoming = (params as { file?: unknown }).file;
    if (!incoming || typeof incoming !== "object") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals file is required"),
      );
      return;
    }
    const normalized = normalizeExecApprovals(incoming as ExecApprovalsFile);
    const next = mergeExecApprovalsSocketDefaults({ normalized, current: snapshot.file });
    saveExecApprovals(next);
    const nextSnapshot = readExecApprovalsSnapshot();
    respond(true, toExecApprovalsPayload(nextSnapshot), undefined);
  },
  "exec.approvals.node.get": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateExecApprovalsNodeGetParams,
        "exec.approvals.node.get",
        respond,
      )
    ) {
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = resolveNodeIdOrRespond(nodeId, respond);
    if (!id) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const res = await context.nodeRegistry.invoke({
        nodeId: id,
        command: "system.execApprovals.get",
        params: {},
      });
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      respond(true, payload, undefined);
    });
  },
  "exec.approvals.node.set": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateExecApprovalsNodeSetParams,
        "exec.approvals.node.set",
        respond,
      )
    ) {
      return;
    }
    const { nodeId, file, baseHash } = params as {
      nodeId: string;
      file: ExecApprovalsFile;
      baseHash?: string;
    };
    const id = resolveNodeIdOrRespond(nodeId, respond);
    if (!id) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const res = await context.nodeRegistry.invoke({
        nodeId: id,
        command: "system.execApprovals.set",
        params: { file, baseHash },
      });
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = safeParseJson(res.payloadJSON ?? null);
      respond(true, payload, undefined);
    });
  },
  "exec.approvals.trust.status": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateExecApprovalsTrustStatusParams,
        "exec.approvals.trust.status",
        respond,
      )
    ) {
      return;
    }
    const agentId = normalizeExecApprovalAgentId((params as { agentId?: string }).agentId);
    const trustWindow = getTrustWindow(agentId);
    const now = Date.now();
    if (!isTrustWindowActive(trustWindow, now)) {
      respond(true, { agentId, trustWindow: null }, undefined);
      return;
    }
    respond(
      true,
      {
        agentId,
        trustWindow: {
          status: trustWindow.status,
          expiresAt: trustWindow.expiresAt,
          grantedAt: trustWindow.grantedAt,
          grantedBy: trustWindow.grantedBy,
          security: trustWindow.security,
          ask: trustWindow.ask,
          remainingMs: Math.max(0, trustWindow.expiresAt - now),
        },
      },
      undefined,
    );
  },
  "exec.approvals.trust": ({ params, respond }) => {
    if (
      !assertValidParams(params, validateExecApprovalsTrustParams, "exec.approvals.trust", respond)
    ) {
      return;
    }
    const trustParams = params as {
      agentId?: string;
      minutes: number;
      grantedBy?: string;
      force?: boolean;
    };
    const result = grantTrustWindow({
      agentId: trustParams.agentId,
      minutes: trustParams.minutes,
      grantedBy: trustParams.grantedBy,
      force: trustParams.force,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      return;
    }
    respond(true, { ok: true, agentId: result.agentId, expiresAt: result.expiresAt }, undefined);
  },
  "exec.approvals.untrust": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateExecApprovalsUntrustParams,
        "exec.approvals.untrust",
        respond,
      )
    ) {
      return;
    }
    const untrustParams = params as { agentId?: string; revokedBy?: string; keepAudit?: boolean };
    const result = revokeTrustWindow({
      agentId: untrustParams.agentId,
      revokedBy: untrustParams.revokedBy,
      keepAudit: untrustParams.keepAudit,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      return;
    }
    if (untrustParams.keepAudit !== true) {
      cleanupTrustAudit(result.agentId);
    }
    respond(
      true,
      {
        ok: true,
        agentId: result.agentId,
        summary: result.summary ?? null,
      },
      undefined,
    );
  },
};
