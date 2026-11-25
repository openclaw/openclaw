import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { WorkspaceHashMemo } from "../gateway/worker-environments/workspace-hash-memo.js";
import type {
  NodeWorkerWorkspaceTransferInput,
  NodeWorkerWorkspaceTransferStage,
} from "../worker/node-workspace-transfer-protocol.js";
import type { NodeWorkerPreparedWorkspaceTransfer } from "./node-worker-prepared-workspace-transfer.js";
import type { NodeWorkerTransferHttpRequest } from "./node-worker-transfer-http.js";

export type WorkspaceTransferContext = {
  seedsRoot?: string;
  gatewayNamespace?: string;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: NodeWorkerWorkspaceTransferInput;
  assertCurrent?: () => void;
  prepared?: NodeWorkerPreparedWorkspaceTransfer;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
};

export type WorkspaceTransferOperation<
  Direction extends NodeWorkerWorkspaceTransferInput["direction"],
> = Omit<WorkspaceTransferContext, "transfer"> & {
  transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: Direction }>;
  request: Pick<
    NodeWorkerTransferHttpRequest,
    "gatewayUrl" | "tlsFingerprint" | "cloudflareAccess" | "token" | "signal"
  >;
  setStage: (stage: NodeWorkerWorkspaceTransferStage) => void;
};
