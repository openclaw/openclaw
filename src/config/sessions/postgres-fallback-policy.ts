export type SessionStoreFallbackPhase =
  | "json-primary"
  | "postgres-shadow"
  | "postgres-primary"
  | "rollback-to-json";

export type SessionStoreFallbackOperation =
  | "read"
  | "write"
  | "batch-write"
  | "transcript-write"
  | "migration-read"
  | "migration-write";

export type SessionStoreJsonFallbackEvidence = {
  phase: SessionStoreFallbackPhase;
  operation: SessionStoreFallbackOperation;
  /**
   * True once any durable Postgres session-store mutation has succeeded in
   * the current adoption epoch. After this point JSON fallback is split-brain
   * unsafe unless an explicit rollback contract is active.
   */
  postgresWriteSucceeded?: boolean;
  /**
   * True once JSON evidence has been imported/applied into Postgres. Treat
   * this like a durable write because silent fallback can hide rollback drift.
   */
  postgresMigrationApplied?: boolean;
  /**
   * The original JSON/session/transcript evidence is still present and
   * intentionally preserved for rollback/audit.
   */
  jsonEvidencePreserved?: boolean;
  /** Operator/integrator explicitly requested rollback instead of fallback. */
  explicitRollbackRequested?: boolean;
  /** Rollback receipt/checklist was recorded before permitting JSON reads/writes again. */
  rollbackReceiptRecorded?: boolean;
};

export type SessionStoreJsonFallbackDenialCode =
  | "write_fallback_forbidden"
  | "postgres_primary_fallback_forbidden"
  | "postgres_write_committed"
  | "postgres_migration_applied"
  | "rollback_not_explicit"
  | "rollback_receipt_missing"
  | "json_evidence_not_preserved";

export type SessionStoreJsonFallbackDenial = {
  code: SessionStoreJsonFallbackDenialCode;
  message: string;
};

export type SessionStoreJsonFallbackAction =
  | "use-json-primary"
  | "allow-shadow-read-fallback"
  | "allow-explicit-rollback-to-json"
  | "deny";

export type SessionStoreJsonFallbackDecision = {
  allowed: boolean;
  action: SessionStoreJsonFallbackAction;
  denials: SessionStoreJsonFallbackDenial[];
};

function isWriteOperation(operation: SessionStoreFallbackOperation): boolean {
  return (
    operation === "write" ||
    operation === "batch-write" ||
    operation === "transcript-write" ||
    operation === "migration-write"
  );
}

function deny(
  denials: SessionStoreJsonFallbackDenial[],
  code: SessionStoreJsonFallbackDenialCode,
  message: string,
): void {
  denials.push({ code, message });
}

function requireExplicitRollback(
  denials: SessionStoreJsonFallbackDenial[],
  evidence: SessionStoreJsonFallbackEvidence,
): void {
  if (evidence.explicitRollbackRequested !== true) {
    deny(
      denials,
      "rollback_not_explicit",
      "JSON fallback from Postgres requires an explicit rollback request, not implicit failover",
    );
  }
  if (evidence.rollbackReceiptRecorded !== true) {
    deny(
      denials,
      "rollback_receipt_missing",
      "JSON rollback requires a recorded rollback receipt/checklist before reuse",
    );
  }
  if (evidence.jsonEvidencePreserved !== true) {
    deny(
      denials,
      "json_evidence_not_preserved",
      "JSON rollback requires preserved JSON/session/transcript evidence",
    );
  }
}

function requireNoCommittedPostgresState(
  denials: SessionStoreJsonFallbackDenial[],
  evidence: SessionStoreJsonFallbackEvidence,
): void {
  if (evidence.postgresWriteSucceeded === true) {
    deny(
      denials,
      "postgres_write_committed",
      "A successful Postgres write makes implicit JSON fallback split-brain unsafe",
    );
  }
  if (evidence.postgresMigrationApplied === true) {
    deny(
      denials,
      "postgres_migration_applied",
      "An applied Postgres migration makes implicit JSON fallback split-brain unsafe",
    );
  }
}

export function evaluateSessionStoreJsonFallback(
  evidence: SessionStoreJsonFallbackEvidence,
): SessionStoreJsonFallbackDecision {
  if (evidence.phase === "json-primary") {
    return {
      allowed: true,
      action: "use-json-primary",
      denials: [],
    };
  }

  const denials: SessionStoreJsonFallbackDenial[] = [];
  const writeOperation = isWriteOperation(evidence.operation);

  if (evidence.phase === "postgres-shadow") {
    if (writeOperation) {
      deny(
        denials,
        "write_fallback_forbidden",
        "Postgres shadow write failures must not silently write JSON as a fallback path",
      );
    }
    requireNoCommittedPostgresState(denials, evidence);
    return {
      allowed: denials.length === 0,
      action: denials.length === 0 ? "allow-shadow-read-fallback" : "deny",
      denials,
    };
  }

  if (evidence.phase === "postgres-primary") {
    deny(
      denials,
      "postgres_primary_fallback_forbidden",
      "Postgres-primary mode cannot silently fall back to JSON; use an explicit rollback",
    );
    requireNoCommittedPostgresState(denials, evidence);
    requireExplicitRollback(denials, evidence);
    return {
      allowed: false,
      action: "deny",
      denials,
    };
  }

  requireExplicitRollback(denials, evidence);
  return {
    allowed: denials.length === 0,
    action: denials.length === 0 ? "allow-explicit-rollback-to-json" : "deny",
    denials,
  };
}
