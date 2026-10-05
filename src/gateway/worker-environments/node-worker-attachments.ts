import type { createNodeWorkspaceTransferCommand } from "./node-workspace-transfer-command.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

export function createNodeWorkerAttachmentStager(params: {
  environmentId: string;
  workspaceTransfer: NodeWorkspaceTransferService;
  transfer: ReturnType<typeof createNodeWorkspaceTransferCommand>;
  waitRepository(signal: AbortSignal): Promise<void>;
}): NonNullable<WorkerWorkspaceTunnelHandle["stageAttachments"]> {
  return async (request) => {
    await params.waitRepository(request.signal);
    const prepared = await params.workspaceTransfer.prepareAttachments({
      ...request,
      environmentId: params.environmentId,
    });
    try {
      await params.transfer(
        {
          direction: "download",
          token: prepared.token,
          manifestRef: prepared.snapshot.manifestRef,
          attachments: true,
        },
        "Worker attachment transfer failed",
        {
          assertCurrent: () => {
            if (!request.isAuthorized()) {
              throw new Error("Worker attachment transfer authority closed");
            }
          },
          signal: request.signal,
        },
      );
    } finally {
      await params.workspaceTransfer.revoke(params.environmentId, prepared.token);
    }
  };
}
