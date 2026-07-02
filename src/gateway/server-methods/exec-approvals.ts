// Exec approvals config methods read and write command approval defaults with
// base-hash protection for admin-edited allowlists.
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
import { assertValidParams, type Validator } from "./validation.js";

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

async function respondWithExecApprovalsNodePayload<TParams extends { nodeId: string }>(params: {
  method: string;
  rawParams: unknown;
  validate: Validator<TParams>;
  context: GatewayRequestContext;
  respond: RespondFn;
  command: "system.execApprovals.get" | "system.execApprovals.set";
  commandParams: (parsedParams: TParams) => Record<string, unknown>;
  readPayload: (response: { payload?: unknown; payloadJSON?: string | null }) => unknown;
}): Promise<void> {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return;
  }
  const parsedParams = rawParams;
  const nodeId = parsedParams.nodeId.trim();
  if (!nodeId) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
    return;
  }
  const nodeSession = params.context.nodeRegistry.get(nodeId);
  if (nodeSession) {
    const cfg = params.context.getRuntimeConfig();
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      ...nodeSession,
      approvedCommands: nodeSession.commands,
    });
    const allowed = isNodeCommandAllowed({
      command: params.command,
      declaredCommands: nodeSession.commands,
      allowlist,
    });
    if (!allowed.ok) {
      // isNodeCommandAllowed checks allowlist before declaredCommands, so
      // "command not allowlisted" can mean either the node genuinely lacks the
      // command in its effective surface, or the operator explicitly blocked it
      // via gateway.nodes.denyCommands.  Check the node's original declared
      // commands to decide which remediation to show — declaredCommands holds
      // what the node actually supports, while commands is the resolved set
      // after allowlist/denyCommands filtering.
      const isDeclared =
        Array.isArray(nodeSession.declaredCommands) &&
        nodeSession.declaredCommands.includes(params.command);
      const errorDetails = {
        supportedCommands: nodeSession.commands,
        requestedCommand: params.command,
        reason: allowed.reason,
      };
      if (allowed.reason === "command not allowlisted" && isDeclared) {
        // The node declared the capability but the effective command surface
        // does not include it — the operator explicitly denied it via
        // gateway.nodes.denyCommands, or the command is gated behind pairing
        // approval.  Return a clear "does not allow" error rather than
        // falling through to nodeRegistry.invoke.
        params.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Node ${nodeId} does not allow ${params.command}: blocked by node command policy.`,
            { details: errorDetails },
          ),
        );
      } else {
        params.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Node ${nodeId} does not support ${params.command}. ` +
              `The node must advertise ${params.command}, or the operator must edit the node host approvals file directly.`,
            { details: errorDetails },
          ),
        );
      }
      return;
    }
  }
  await respondUnavailableOnThrow(params.respond, async () => {
    const res = await params.context.nodeRegistry.invoke({
      nodeId,
      command: params.command,
      params: params.commandParams(parsedParams),
    });
    if (!respondUnavailableOnNodeInvokeError(params.respond, res)) {
      return;
    }
    params.respond(true, params.readPayload(res), undefined);
  });
}

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      respond(true, toExecApprovalsPayload(snapshot), undefined);
    });
  },
  "exec.approvals.set": async ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
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
    });
  },
  "exec.approvals.node.get": async ({ params, respond, context }) => {
    await respondWithExecApprovalsNodePayload({
      method: "exec.approvals.node.get",
      rawParams: params,
      validate: validateExecApprovalsNodeGetParams,
      context,
      respond,
      command: "system.execApprovals.get",
      commandParams: () => ({}),
      // Node invocations can return structured payloads or JSON strings
      // depending on the transport; normalize before echoing the RPC response.
      readPayload: (res) => (res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload),
    });
  },
  "exec.approvals.node.set": async ({ params, respond, context }) => {
    await respondWithExecApprovalsNodePayload({
      method: "exec.approvals.node.set",
      rawParams: params,
      validate: validateExecApprovalsNodeSetParams,
      context,
      respond,
      command: "system.execApprovals.set",
      commandParams: (parsedParams) => ({
        file: parsedParams.file,
        baseHash: parsedParams.baseHash,
      }),
      // node.set returns JSON on the command channel; keep the gateway response
      // shape aligned with local exec.approvals.set.
      readPayload: (res) => safeParseJson(res.payloadJSON ?? null),
    });
  },
};
