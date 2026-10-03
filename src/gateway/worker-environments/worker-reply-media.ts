import path from "node:path";
import { bindHarnessReplyMedia } from "../../agents/harness/reply-media.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createBoundedRemoteFileReader } from "../../media/remote-workspace-file.js";
import { NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { workerWorkspaceCommandSucceeded, workspaceSyncError } from "./workspace-sync-helpers.js";

export type WorkerReplyMediaPreparer = (payload: ReplyPayload) => Promise<ReplyPayload>;

export function createWorkerReplyMedia(params: {
  turn: SessionPlacementTurnParams;
  remoteWorkspaceDir: string;
  tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand">;
  assertCurrent: () => void;
  signal: AbortSignal;
}): WorkerReplyMediaPreparer {
  const { assertCurrent } = params;
  const readFile = createBoundedRemoteFileReader({
    outputBytesCap: NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
    assertCurrent,
    execute: async (argv, options) => {
      const result = await params.tunnel.runWorkspaceCommand({
        argv,
        ...options,
        assertCurrent,
        transportRetry: "idempotent",
      });
      if (!workerWorkspaceCommandSucceeded(result) || result.stdoutTruncatedBytes) {
        throw workspaceSyncError(result);
      }
      return result.stdout;
    },
  });
  const prepare = bindHarnessReplyMedia({
    attempt: params.turn,
    config: params.turn.config,
    assertActive: assertCurrent,
    signal: params.signal,
  });
  return async (payload) => {
    if (
      !payload.mediaUrl &&
      !payload.mediaUrls?.length &&
      !parseReplyDirectives(payload.text ?? "").mediaUrls?.length
    ) {
      return payload;
    }
    const prepared = await prepare?.({
      kind: "payload",
      payload,
      workspaceRoot: params.remoteWorkspaceDir,
      // Workspace commands already execute in the physical worker workspace.
      readWorkspaceFile: (relativePath, options) =>
        readFile({
          path: relativePath.split(path.sep).join("/"),
          workspaceRoot: params.remoteWorkspaceDir,
          ...options,
          timeoutMs: 60_000,
        }),
    });
    if (prepared?.kind !== "payload") {
      throw new Error("Worker reply media preparation is unavailable");
    }
    return prepared.payload;
  };
}
