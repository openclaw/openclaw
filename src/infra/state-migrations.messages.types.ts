export type MigrationMessages = {
  changes: string[];
  warnings: string[];
  notices?: string[];
  /** Active plugin owners whose required migration phases were inspected and completed. */
  completedPluginIds?: readonly string[];
  /** Actual loaded migration contracts, independent of detector or writer success. */
  requiredPluginIds?: readonly string[];
  /** Successful contract inspection found no state actions; this is not completion proof. */
  statelessPluginIds?: readonly string[];
  rehearsal?: { outsideRootLegacyFileCount: number };
  /** The owner classified every warning as advisory, including a source-preserving skip. */
  warningDisposition?: "recoverable";
  /** An intentional non-outcome can carry advisory warnings without becoming a refusal. */
  outcome?: "skipped" | "deferred";
  deferred?: Array<{
    reason: "owner-mismatch";
    recordedOwner: string;
    configuredOwner: string;
    path: string;
  }>;
  sqliteFamilies?: Array<{
    database: string;
    files: string[];
    destination: string;
    outcome: "deferred";
    reason: "sqlite-family";
  }>;
  /** Every blocking warning is an ownership refusal confined to these agent databases. */
  refusedAgentDatabasePaths?: readonly string[];
  /** Wrong-owner copies successfully quarantined by this pass, after verifying the original. */
  recoveredAgentDatabasePaths?: readonly string[];
};
