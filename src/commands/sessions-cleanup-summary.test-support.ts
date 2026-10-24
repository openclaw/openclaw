import type { SessionCleanupSummary } from "../config/sessions.js";

export function cleanupSummary(overrides: Partial<SessionCleanupSummary>): SessionCleanupSummary {
  return {
    agentId: "main",
    storePath: "/tmp/main/sessions.json",
    mode: "warn",
    dryRun: true,
    beforeCount: 0,
    afterCount: 0,
    missing: 0,
    dmScopeRetired: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
    unreferencedArtifacts: { scannedFiles: 0, removedFiles: 0, freedBytes: 0, olderThanMs: 0 },
    diskBudget: null,
    wouldMutate: false,
    ...overrides,
  };
}
