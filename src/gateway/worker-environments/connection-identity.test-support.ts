import type { WorkerConnectionIdentity } from "./connection-identity.js";

export function createWorkerConnectionIdentity(
  turnClaim: WorkerConnectionIdentity["turnClaim"] = null,
  overrides: Partial<Omit<WorkerConnectionIdentity, "turnClaim">> = {},
): WorkerConnectionIdentity {
  return {
    environmentId: turnClaim?.owner.environmentId ?? "environment",
    credentialHash: "credential-hash",
    bundleHash: "a".repeat(64),
    sessionId: turnClaim?.sessionId ?? null,
    runId: turnClaim?.runId ?? null,
    turnClaim,
    ownerEpoch: turnClaim?.owner.ownerEpoch ?? 1,
    rpcSetVersion: 1,
    protocolFeatures: [],
    credentialExpiresAtMs: 10_000,
    ...overrides,
  };
}
