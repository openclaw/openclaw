import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";

export function resolveSessionObserverDigestForLifecycle(
  digest: SessionObserverDigest | undefined,
  lifecycle: Pick<SessionObserverDigest, "sessionId" | "lifecycleRevision"> | undefined,
): SessionObserverDigest | undefined {
  if (
    !digest ||
    !lifecycle ||
    (digest.sessionId !== undefined && digest.sessionId !== lifecycle.sessionId) ||
    ((digest.sessionId !== undefined || digest.lifecycleRevision !== undefined) &&
      digest.lifecycleRevision !== lifecycle.lifecycleRevision)
  ) {
    return undefined;
  }
  // Legacy stored digests inherit the captured owner before any asynchronous write.
  return {
    ...digest,
    ...(lifecycle.sessionId ? { sessionId: lifecycle.sessionId } : {}),
    ...(lifecycle.lifecycleRevision ? { lifecycleRevision: lifecycle.lifecycleRevision } : {}),
  };
}
