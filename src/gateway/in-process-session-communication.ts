import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Host-only, one-input policy custody. No public provenance field can create this binding. */
export type SessionCommunicationInput = {
  assertCurrent: () => void;
  release: () => void;
};
type SessionCommunicationInputSource = { retain: () => SessionCommunicationInput };
const inputs = resolveGlobalSingleton<
  WeakMap<object, { source: SessionCommunicationInputSource; binding: string }>
>(Symbol.for("openclaw.inProcessSessionCommunicationInputs"), () => new WeakMap());
type CommunicationRequest = {
  agentId?: unknown;
  sessionKey?: unknown;
  message?: unknown;
  inputProvenance?: unknown;
};
const binding = (request: CommunicationRequest) =>
  JSON.stringify([request.agentId, request.sessionKey, request.message, request.inputProvenance]);

export function bindSessionCommunicationInput<T extends CommunicationRequest>(
  request: T,
  source: SessionCommunicationInputSource,
): T {
  inputs.set(request, { source, binding: binding(request) });
  return request;
}

/** The input owner takes the single retained policy check through queueing and model dispatch. */
export function claimSessionCommunicationInput(
  request: CommunicationRequest,
): SessionCommunicationInput | undefined {
  const admitted = inputs.get(request);
  if (!admitted) {
    return undefined;
  }
  inputs.delete(request);
  if (admitted.binding !== binding(request)) {
    throw new Error("Approved communication input changed.");
  }
  return admitted.source.retain();
}
