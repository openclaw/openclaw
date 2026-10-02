import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";

export function nodeWorkerDescriptorSecrets(descriptor: WorkerLaunchDescriptor): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  return [
    descriptor.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
    ...(descriptor.assignment.github ? [descriptor.assignment.github.token] : []),
  ];
}
