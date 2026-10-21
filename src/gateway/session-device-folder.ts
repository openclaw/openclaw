import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../infra/node-commands.js";
import {
  NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import { resolveSessionCreateInitialTurn } from "./server-methods/session-create-initial-turn.js";

export function validateSessionDeviceFolderSelection(
  params: SessionsCreateParams,
): ErrorShape | undefined {
  if (!params.deviceFolder) {
    return undefined;
  }
  const conflicts = [
    "worktree",
    "worktreeSource",
    "worktreeBaseRef",
    "worktreeName",
    "cwd",
    "projectId",
    "projectGitUrl",
    "repository",
    "execNode",
    "catalogId",
  ] as const;
  if (conflicts.some((key) => params[key] !== undefined)) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create deviceFolder cannot be combined with worktree, cwd, project, repository, execNode, or catalog selections",
    );
  }
  if (!params.deviceFolder.deviceId.trim() || !params.deviceFolder.path.trim()) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create deviceFolder requires a device and path",
    );
  }
  // The folder exists only after explicit dispatch; an inline turn would run before placement.
  if (resolveSessionCreateInitialTurn(params)?.hasInitialTurn !== false) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create deviceFolder cannot include an initial turn; dispatch the session with sessions.dispatch, then send the message with sessions.send.",
    );
  }
  return undefined;
}

/** Validation never creates a workspace, copies files, or executes repository code. */
export async function prepareSessionDeviceFolder(params: {
  folder: NonNullable<SessionsCreateParams["deviceFolder"]>;
  transport: NodeWorkerSupervisorTransport;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<
  Result<
    { deviceFolder: NonNullable<SessionsCreateParams["deviceFolder"]>; assertCurrent: () => void },
    ErrorShape
  >
> {
  const { transport, assertCurrent } = params;
  assertCurrent();
  const deviceId = params.folder.deviceId.trim();
  const node = await transport.getCurrentNode(deviceId);
  assertCurrent();
  if (!node || node.workerHost.deviceFolders !== true) {
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Selected device is disconnected or does not support existing-folder sessions; connect an updated session host and retry.",
      ),
    );
  }
  const isCurrent = () => {
    assertCurrent();
    return transport.isCurrent(node) && node.workerHost.deviceFolders === true;
  };
  try {
    const response = await transport.invoke({
      node,
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      params: {
        // This read-only operation returns before the node opens any namespace-owned state.
        gatewayNamespace: "device-folder-validation",
        environmentId: `validate:${randomUUID()}`,
        sessionId: "validation",
        generation: 0,
        deviceFolder: params.folder.path,
        argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND],
      },
      timeoutMs: 15_000,
      signal: params.signal,
      isDispatchAuthorized: isCurrent,
    });
    if (!isCurrent()) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Selected device changed during folder validation; retry.",
        ),
      );
    }
    if (!response.ok) {
      return err(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          response.error?.message ?? "Selected device could not validate the existing folder.",
        ),
      );
    }
    const raw: unknown =
      response.payload ?? (response.payloadJSON ? JSON.parse(response.payloadJSON) : undefined);
    const result = parseNodeWorkerWorkspaceExecResult(raw);
    if (!result || result.code !== 0 || result.termination !== "exit" || !result.workspaceDir) {
      return err(
        errorShape(ErrorCodes.INVALID_REQUEST, "Selected device rejected the existing folder."),
      );
    }
    return ok({
      deviceFolder: { deviceId, path: result.workspaceDir },
      assertCurrent: () => {
        if (!transport.isCurrent(node) || node.workerHost.deviceFolders !== true) {
          throw new Error("Selected device changed after folder validation; reconnect and retry.");
        }
      },
    });
  } catch (error) {
    assertCurrent();
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `Device folder validation failed: ${formatErrorMessage(error)}`,
      ),
    );
  }
}
