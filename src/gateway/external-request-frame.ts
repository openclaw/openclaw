/**
 * Request frames that arrived on an authenticated operator transport. In-process
 * dispatch (plugin RPC re-entry, agent tools, internal facades) always builds its
 * own frame, so a preserved operator client never makes such a request external.
 */
const externalRequestFrames = new WeakSet<object>();

/** Transport ingress only; never call for a frame built inside the Gateway. */
export function markExternalGatewayRequestFrame(req: object): void {
  externalRequestFrames.add(req);
}

export function isExternalGatewayRequestFrame(req: unknown): boolean {
  return typeof req === "object" && req !== null && externalRequestFrames.has(req);
}
