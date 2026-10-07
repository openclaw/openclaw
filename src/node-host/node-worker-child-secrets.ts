import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  nodeWorkerNativeInferenceSecretsForDescriptor,
  type NodeWorkerNativeInferenceSnapshot,
} from "./node-worker-native-inference.js";

/** Collect every secret exposed to one physical worker child for diagnostic scrubbing. */
export function nodeWorkerLaunchSecrets(
  descriptor: WorkerLaunchDescriptor,
  nativeInference: NodeWorkerNativeInferenceSnapshot | undefined,
): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  return [
    descriptor.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
    ...(descriptor.assignment.github ? [descriptor.assignment.github.token] : []),
    ...nodeWorkerNativeInferenceSecretsForDescriptor(nativeInference, descriptor),
  ];
}
