import {
  createArtifactTransferService,
  type ArtifactTransferOptions,
  type TransferArtifact,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";

export function createWorkerBootstrapArtifactTransferService(
  options: ArtifactTransferOptions = {},
) {
  const transfer = createArtifactTransferService(options);
  return {
    ...transfer,
    prepare(params: {
      artifact: TransferArtifact;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }) {
      return transfer.prepare({
        ...params,
        artifactKey: params.artifact.tarballSha256,
        ttlMs: workerBootstrapOperationTimeoutMs(params.artifact),
        // Proxies can finish receiving an archive before resetting the node's connection.
        maxServes: 3,
      });
    },
  };
}

export type WorkerBootstrapArtifactTransferService = ReturnType<
  typeof createWorkerBootstrapArtifactTransferService
>;
