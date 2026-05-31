import {
  ErrorCodes,
  errorShape,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ensureExecApprovals,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireApprovalsBaseHash(
  params: unknown,
  snapshot: ExecApprovalsSnapshot,
  respond: RespondFn,
): boolean {
  // Approval allowlists are admin-editable state. Require the caller's last
  // observed hash before writing so stale UI tabs cannot overwrite changes.
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
  // The socket token/defaults are runtime-only; expose only the path needed by
  // the editor so GET responses cannot leak connection material.
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

function ensureNodeCommandAllowed(params: {
  context: GatewayRequestContext;
  nodeId: string;
  command: string;
  respond: RespondFn;
}): boolean {
  const nodeSession = params.context.nodeRegistry.get(params.nodeId);
  if (!nodeSession) {
    return true;
  }
  const allowlist = resolveNodeCommandAllowlist(params.context.getRuntimeConfig(), {
    ...nodeSession,
    approvedCommands: nodeSession.commands,
  });
  const allowed = isNodeCommandAllowed({
    command: params.command,
    declaredCommands: nodeSession.commands,
    allowlist,
  });
  if (allowed.ok) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `node command not allowed: "${params.command}" is not approved for node "${params.nodeId}"`,
      {
        details: { reason: allowed.reason, command: params.command },
      },
    ),
  );
  return false;
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
    const incoming = params.file;
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
    const { nodeId } = params;
    const id = resolveNodeIdOrRespond(nodeId, respond);
    if (!id) {
      return;
    }
    if (
      !ensureNodeCommandAllowed({
        context,
        nodeId: id,
        command: "system.execApprovals.get",
        respond,
      })
    ) {
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
      // Node invocations can return structured payloads or JSON strings
      // depending on the transport; normalize before echoing the RPC response.
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
    const { nodeId } = params;
    const file = "file" in params ? params.file : undefined;
    const native = "native" in params ? params.native : undefined;
    const baseHash = "baseHash" in params ? params.baseHash : undefined;
    const id = resolveNodeIdOrRespond(nodeId, respond);
    if (!id) {
      return;
    }
    if (
      !ensureNodeCommandAllowed({
        context,
        nodeId: id,
        command: "system.execApprovals.set",
        respond,
      })
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const res = await context.nodeRegistry.invoke({
        nodeId: id,
        command: "system.execApprovals.set",
        params: native ? { ...native, baseHash } : { file, baseHash },
      });
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      // Node transports may return structured payloads or JSON strings; keep
      // node.set aligned with the local exec.approvals.set response shape.
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      respond(true, payload ?? {}, undefined);
    });
  },
};
