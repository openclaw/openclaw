import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";

/** Decode the private node response envelope before its operation validates the payload. */
export function parseNodeWorkerResponse(
  value: string | null | undefined,
  operation: string,
): unknown {
  if (!value) {
    throw new Error(operation + " omitted its result");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(operation + " returned malformed JSON");
  }
}
/** Keep private RPC details out of general command failures while retaining transfer context. */
export function workspaceCommandError(
  error: { code?: string; message?: string } | null | undefined,
) {
  const code = error?.code ?? "UNAVAILABLE";
  return code === NODE_WORKSPACE_TRANSFER_ERROR_CODE
    ? new NodeWorkerWorkspaceTransferError(
        error?.message ?? "workspace-transfer-failed: transfer did not complete",
      )
    : new Error(
        error?.message && code === "INVALID_REQUEST"
          ? `node workspace command failed (${code}): ${error.message}`
          : `node workspace command failed (${code})`,
      );
}
