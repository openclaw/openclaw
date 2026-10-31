import path from "node:path";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import type { AgentWorkspaceAccess } from "./workspace-access.js";

/** Reuse an owned filesystem transport for admitted inputs; this does not establish a backend. */
export function createWorkspaceAttachmentPreparer(params: {
  /** Wrap the same backend for this turn; check authority before every physical command. */
  createBridge: (
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => Pick<SandboxFsBridge, "readFile" | "stat"> &
    Required<Pick<SandboxFsBridge, "createFileExclusive">>;
  remoteRoot: string;
}): NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]> {
  if (!path.posix.isAbsolute(params.remoteRoot) && !path.win32.isAbsolute(params.remoteRoot)) {
    throw new Error("Attachment workspace root must be absolute");
  }
  return async (turn, assertCurrent) => {
    const { prepareWorkspaceAttachments } = await import("./workspace-attachments.js");
    assertCurrent();
    return await prepareWorkspaceAttachments({ ...params, turn, assertCurrent });
  };
}
