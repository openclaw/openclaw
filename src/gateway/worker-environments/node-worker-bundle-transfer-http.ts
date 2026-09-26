import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../../worker/node-bundle-install-protocol.js";
import { classifyNodeWorkerBundleTransferPath } from "../gateway-http-route-contracts.js";
import {
  handleArtifactTransferHttpRequest,
  type ArtifactTransferHttpCallback,
  type ArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";

export function handleNodeWorkerBundleTransferHttpRequest(
  params: ArtifactTransferHttpRequest & { callback?: ArtifactTransferHttpCallback },
): Promise<boolean> {
  return handleArtifactTransferHttpRequest({
    ...params,
    classifyPath: classifyNodeWorkerBundleTransferPath,
    routePrefix: `${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`,
  });
}
