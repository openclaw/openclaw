import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  ensureExecApprovals,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  resolveExecApprovalsSocketPath,
  saveExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "../protocol/index.js";
import { respondUnavailableOnThrow, safeParseJson } from "./nodes.helpers.js";

function resolveBaseHash(params: unknown): string | null {
  const raw = (params as { baseHash?: unknown })?.baseHash;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

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
  const baseHash = resolveBaseHash(params);
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

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": ({ params, respond }) => {
    if (!validateExecApprovalsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid exec.approvals.get params: ${formatValidationErrors(validateExecApprovalsGetParams.errors)}`,
        ),
      );
      return;
    }
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();
    respond(
      true,
      {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
      },
      undefined,
    );
  },
  "exec.approvals.set": ({ params, respond }) => {
    if (!validateExecApprovalsSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid exec.approvals.set params: ${formatValidationErrors(validateExecApprovalsSetParams.errors)}`,
        ),
      );
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
    const currentSocketPath = snapshot.file.socket?.path?.trim();
    const currentToken = snapshot.file.socket?.token?.trim();
    const socketPath =
      normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
    const token = normalized.socket?.token?.trim() ?? currentToken ?? "";
    const next: ExecApprovalsFile = {
      ...normalized,
      socket: {
        path: socketPath,
        token,
      },
    };
    saveExecApprovals(next);
    const nextSnapshot = readExecApprovalsSnapshot();
    respond(
      true,
      {
        path: nextSnapshot.path,
        exists: nextSnapshot.exists,
        hash: nextSnapshot.hash,
        file: redactExecApprovals(nextSnapshot.file),
      },
      undefined,
    );
  },
  "exec.approvals.node.get": async ({ params, respond, context }) => {
    if (!validateExecApprovalsNodeGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid exec.approvals.node.get params: ${formatValidationErrors(validateExecApprovalsNodeGetParams.errors)}`,
        ),
      );
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = nodeId.trim();
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const res = await context.nodeRegistry.invoke({
        nodeId: id,
        command: "system.execApprovals.get",
        params: {},
      });
      if (!res.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, res.error?.message ?? "node invoke failed", {
            details: { nodeError: res.error ?? null },
          }),
        );
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      respond(true, payload, undefined);
    });
  },
  "exec.approvals.node.set": async ({ params, respond, context }) => {
    if (!validateExecApprovalsNodeSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid exec.approvals.node.set params: ${formatValidationErrors(validateExecApprovalsNodeSetParams.errors)}`,
        ),
      );
      return;
    }
    const { nodeId, file, baseHash } = params as {
      nodeId: string;
      file: ExecApprovalsFile;
      baseHash?: string;
    };
    const id = nodeId.trim();
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const res = await context.nodeRegistry.invoke({
        nodeId: id,
        command: "system.execApprovals.set",
        params: { file, baseHash },
      });
      if (!res.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, res.error?.message ?? "node invoke failed", {
            details: { nodeError: res.error ?? null },
          }),
        );
        return;
      }
      const payload = safeParseJson(res.payloadJSON ?? null);
      respond(true, payload, undefined);
    });
  },
};
