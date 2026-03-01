import {
  ensureExecApprovals,
  grantTrustWindow,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
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

  "exec.approvals.trust": ({ params, respond }) => {
    const p = params as { agentId?: string; minutes?: number; grantedBy?: string; force?: boolean };
    const minutes = typeof p.minutes === "number" ? p.minutes : 0;
    const result = grantTrustWindow({
      agentId: p.agentId,
      minutes,
      grantedBy: p.grantedBy,
      force: p.force,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      return;
    }
    respond(true, { ok: true, expiresAt: result.expiresAt, agentId: result.agentId }, undefined);
  },

  "exec.approvals.untrust": ({ params, respond }) => {
    const p = params as { agentId?: string; revokedBy?: string; keepAudit?: boolean };
    const result = revokeTrustWindow({
      agentId: p.agentId,
      revokedBy: p.revokedBy,
      keepAudit: p.keepAudit,
    });
    if (!result.ok) {
      respond(
        true,
        { ok: false, agentId: p.agentId?.trim() || "main", message: result.error },
        undefined,
      );
      return;
    }
    if (!p.keepAudit) {
      cleanupTrustAudit(result.agentId);
    }
    respond(true, { ok: true, agentId: result.agentId, summary: result.summary }, undefined);
  },
};
