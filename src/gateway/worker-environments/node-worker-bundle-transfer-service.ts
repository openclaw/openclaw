import type { NodeWorkerBundleInstallInput } from "../../worker/node-bundle-install-protocol.js";
import {
  createArtifactTransferService,
  type ArtifactTransferOptions,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

export function createNodeWorkerBundleTransferService(options: ArtifactTransferOptions = {}) {
  const transfer = createArtifactTransferService(options);
  return {
    ...transfer,
    prepare(params: {
      gatewayNamespace: string;
      artifact: WorkerBundleArtifact;
      bundlePrewarm?: 1;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
      onProgress?: (servedBytes: number) => void;
      onInterrupted?: (servedBytes: number, reason: string) => void;
    }): { token: string; input: NodeWorkerBundleInstallInput } {
      // The caller's live-authority check owns the node binding.
      const { token } = transfer.prepare({
        ...params,
        artifactKey: params.artifact.bundleHash,
        ttlMs: workerBootstrapOperationTimeoutMs(params.artifact),
        // Allow ranged resumes, bounded by the size-derived lifetime and exact live owner.
        maxServes: 256,
      });
      return {
        token,
        input: {
          gatewayNamespace: params.gatewayNamespace,
          ...(params.bundlePrewarm ? { bundlePrewarm: params.bundlePrewarm } : {}),
          build: {
            bundleHash: params.artifact.bundleHash,
            openclawVersion: params.artifact.openclawVersion,
            protocolFeatures: [...params.artifact.protocolFeatures],
          },
          archive: {
            token,
            sha256: params.artifact.tarballSha256,
            bytes: params.artifact.tarballBytes,
          },
        },
      };
    },
  };
}

export type NodeWorkerBundleTransferService = ReturnType<
  typeof createNodeWorkerBundleTransferService
>;
