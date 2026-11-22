export type SessionMaintenancePreservationSnapshot = {
  providerKeys: string[];
  workIdentities: string[];
  lifecycleIdentities: string[];
  /** A provider has not loaded its protection yet; automatic archiving waits for it. */
  archivingDeferred?: true;
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
