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
  getMethod = "exec.approvals.get",
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
        `exec approvals base hash unavailable; re-run ${getMethod} and retry`,
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
        `exec approvals base hash required; re-run ${getMethod} and retry`,
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
        `exec approvals changed since last load; re-run ${getMethod} and retry`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNodeExecApprovalsPayload(response: {
  payload?: unknown;
  payloadJSON?: string | null;
}): unknown {
  return response.payloadJSON ? safeParseJson(response.payloadJSON) : response.payload;
}

function toNodeExecApprovalsSnapshot(payload: unknown): ExecApprovalsSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const payloadHash =
    typeof payload.hash === "string"
      ? payload.hash
      : typeof payload.baseHash === "string"
        ? payload.baseHash
        : "";
  const exists = typeof payload.exists === "boolean" ? payload.exists : Boolean(payloadHash);
  if (!exists && !("exists" in payload)) {
    return null;
  }
  const path = typeof payload.path === "string" && payload.path.trim() ? payload.path : "<node>";
  const file: ExecApprovalsFile = isRecord(payload.file)
    ? (payload.file as ExecApprovalsFile)
    : { version: 1 };
  return {
    path,
    exists,
    raw: null,
    file,
    hash: payloadHash,
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
      readPayload: readNodeExecApprovalsPayload,
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
    const parsedParams = params;
    const nodeId = parsedParams.nodeId.trim();
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const getResponse = await context.nodeRegistry.invoke({
        nodeId,
        command: "system.execApprovals.get",
        params: {},
      });
      if (!respondUnavailableOnNodeInvokeError(respond, getResponse)) {
        return;
      }
      const snapshot = toNodeExecApprovalsSnapshot(readNodeExecApprovalsPayload(getResponse));
      if (!snapshot) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "node exec approvals snapshot unavailable; re-run exec.approvals.node.get and retry",
          ),
        );
        return;
      }
      if (!requireApprovalsBaseHash(params, snapshot, respond, "exec.approvals.node.get")) {
        return;
      }
      const setResponse = await context.nodeRegistry.invoke({
        nodeId,
        command: "system.execApprovals.set",
        params: {
          file: parsedParams.file,
          baseHash: parsedParams.baseHash,
        },
      });
      if (!respondUnavailableOnNodeInvokeError(respond, setResponse)) {
        return;
      }
      // node.set returns JSON on the command channel; keep the gateway response
      // shape aligned with local exec.approvals.set.
      respond(true, safeParseJson(setResponse.payloadJSON ?? null), undefined);
    });
  },
};
