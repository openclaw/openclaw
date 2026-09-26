import {
  classifyWorkerBootstrapArtifactTransferPath,
  WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH,
} from "../gateway-http-route-contracts.js";
import {
  handleArtifactTransferHttpRequest,
  type ArtifactTransferHttpCallback,
  type ArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";

export function handleWorkerBootstrapArtifactTransferHttpRequest(
  params: ArtifactTransferHttpRequest & { callback?: ArtifactTransferHttpCallback },
): Promise<boolean> {
  return handleArtifactTransferHttpRequest({
    ...params,
    classifyPath: classifyWorkerBootstrapArtifactTransferPath,
    routePrefix: `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/`,
  });
}
