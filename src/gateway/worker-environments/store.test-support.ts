export function workerCredential(credentialHash = "b".repeat(43), sessionId: string | null = null) {
  return { credentialHash, sessionId, rpcSetVersion: 1, expiresAtMs: 2_000 };
}

export function workerReadyPatch(leaseId: string, nodeDeviceId: string) {
  return {
    leaseId,
    nodeDeviceId,
    sharedHost: false,
    bootstrapReceipt: {
      bundleHash: "a".repeat(64),
      openclawVersion: "test",
      protocolFeatures: [],
    },
    credential: workerCredential(),
  };
}
