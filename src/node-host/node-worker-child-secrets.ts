import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { NodeWorkerManagedIdentityTransport } from "./node-worker-environment.js";
import type { NodeWorkerNativeInferenceSnapshot } from "./node-worker-native-inference.js";

/** Collect every secret exposed to one physical worker child for diagnostic scrubbing. */
export function nodeWorkerLaunchSecrets(
  descriptor: WorkerLaunchDescriptor,
  nativeInference: NodeWorkerNativeInferenceSnapshot | undefined,
  managedIdentityTransport?: NodeWorkerManagedIdentityTransport,
): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  const secrets = [
    descriptor.admission.credential,
    ...(managedIdentityTransport ? [managedIdentityTransport.header] : []),
    ...(access ? [access.clientId, access.clientSecret] : []),
    ...(descriptor.assignment.github ? [descriptor.assignment.github.token] : []),
  ];
  if (descriptor.assignment.inference === "runtime-local" && nativeInference) {
    for (const { model, credential } of nativeInference.models.values()) {
      secrets.push(
        ...[credential, ...Object.values(model.headers ?? {})].filter((value) => value.length > 0),
      );
    }
  }
  return secrets;
}
