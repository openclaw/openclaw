import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";

export function sessionStorageStatus(
  agents: SessionsStorageStatusResult["agents"] = [],
  maintenance: Partial<SessionsStorageStatusResult["maintenance"]> = {},
): SessionsStorageStatusResult {
  return {
    agents,
    maintenance: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
      ...maintenance,
    },
  };
}
