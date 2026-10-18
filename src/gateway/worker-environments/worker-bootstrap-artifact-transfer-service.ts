import {
  createArtifactTransferService,
  type ArtifactTransferOptions,
  type TransferArtifact,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";

export function createWorkerBootstrapArtifactTransferService(
  options: ArtifactTransferOptions = {},
) {
  const transfer = createArtifactTransferService(options);
  return {
    ...transfer,
    prepare(params: {
      artifact: TransferArtifact;
      /** Total bytes downloaded concurrently through the same Gateway uplink. */
      transferBytes?: number;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }) {
      return transfer.prepare({
        ...params,
        artifactKey: params.artifact.tarballSha256,
        ttlMs: workerBootstrapOperationTimeoutMs({
          tarballBytes: params.transferBytes ?? params.artifact.tarballBytes,
        }),
        // Allow frequent ranged resumes without granting unlimited artifact replays.
        // The size-derived lifetime and live owner still bound every serial serve.
        maxServes: 256,
      });
    },
  };
}

export type WorkerBootstrapArtifactTransferService = ReturnType<
  typeof createWorkerBootstrapArtifactTransferService
>;
