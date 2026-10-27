import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { prepareSessionFileWorkspace } from "../session-file-workspace.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import { retainSessionFileSourceReads } from "./session-file-read-authority.js";
import { rejectDeviceFolderFiles } from "./session-files-errors.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Native reveal consumes the file route's retained source without selecting another workspace. */
export async function respondSessionWorkspaceReveal(params: {
  options: GatewayRequestHandlerOptions;
  agentId: string;
  loaded: {
    entry?: InternalSessionEntry;
    root?: string;
    fileWorkspace?: Awaited<ReturnType<typeof prepareSessionFileWorkspace>>;
  };
  assertCurrent: () => void;
}): Promise<void> {
  const { options, agentId, loaded, assertCurrent } = params;
  const { respond, context } = options;
  using sourceReads = await retainSessionFileSourceReads(options, agentId, loaded.fileWorkspace);
  if (rejectDeviceFolderFiles(loaded.entry, respond)) {
    return;
  }
  if (loaded.entry?.repositoryWorkspaceId) {
    respond(true, {
      ok: false,
      error:
        "This repository exists only on the cloud session runner. Use the Files panel to browse it; there is no Gateway checkout to reveal.",
    });
    return;
  }
  const workspaceRoot = loaded.root;
  if (!workspaceRoot) {
    respond(true, {
      ok: false,
      error: "No workspace root is available for this session.",
    });
    return;
  }
  if (loaded.entry?.execNode || getAgentWorkspaceAccess(workspaceRoot)) {
    respond(true, {
      ok: false,
      path: workspaceRoot,
      error: loaded.entry?.execNode
        ? "Cannot reveal this workspace because the session runs on an exec node."
        : "Cannot reveal this workspace because its files live on a remote host.",
    });
    return;
  }
  const placement = await readSessionWorkerPlacementAsync({
    context,
    sessionId: loaded.entry?.sessionId,
  });
  if (isCloudWorkerPlacementState(placement?.state)) {
    respond(true, {
      ok: false,
      path: workspaceRoot,
      error: `Cannot reveal this workspace because the session runs remotely (${placement.state}).`,
    });
    return;
  }
  const command = resolveOpenPathCommand(workspaceRoot);
  try {
    assertCurrent();
    sourceReads.assertCurrent();
    await loaded.fileWorkspace?.settle(() => {
      assertCurrent();
      sourceReads.assertCurrent();
    });
    assertCurrent();
    sourceReads.assertCurrent();
    await execOpenPath(command);
    assertCurrent();
    sourceReads.assertCurrent();
    respond(true, { ok: true, path: workspaceRoot });
  } catch (error) {
    const errorMessage = formatOpenPathError(error);
    const detailedError = isHeadlessOpenPathError(error, command)
      ? `Cannot open path in headless environment. Path: ${workspaceRoot}. This environment appears to lack a graphical or terminal browser handler.`
      : `Failed to reveal session workspace: ${errorMessage}`;
    context.logGateway.warn(
      `sessions.files.reveal failed path=${sanitizePathForLog(workspaceRoot)}: ${errorMessage}`,
    );
    respond(true, { ok: false, path: workspaceRoot, error: detailedError });
  }
}
