export type SessionMaintenancePreservationSnapshot = {
  providerKeys: string[];
  workIdentities: string[];
  lifecycleIdentities: string[];
};

/** Candidate identities needed by the final live-protection check. */
export type SessionMaintenancePreservationPlan = {
  archivedEntries: readonly { sessionKey: string; sessionId?: string }[];
  entryRemovals: readonly {
    sessionKey: string;
    expectedEntry?: { sessionId: string };
  }[];
  stateDeletePlans: readonly { sessionId: string }[];
};
