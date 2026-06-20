export type PostgresSessionStoreRolloutPhase =
  | "nonlive-integration"
  | "migration-rollback-proof"
  | "no-agent-load-proof"
  | "target-runtime-proof"
  | "c7-resume";

export type PostgresSessionStoreDedicatedDbEvidence = {
  approvalRecorded?: boolean;
  approvalReceiptPath?: string;
  usesDedicatedSessionStoreUrl?: boolean;
  usesGenericDatabaseUrl?: boolean;
  sharesCmsPayloadSupabasePool?: boolean;
  tenantId?: string;
  gatewayId?: string;
  schema?: string;
};

export type PostgresSessionStoreC7ResumeChecklist = {
  exactLanes?: boolean;
  concurrencyBudget?: boolean;
  gatewayRouting?: boolean;
  stopCommands?: boolean;
  evidencePath?: boolean;
};

export type PostgresSessionStoreRolloutEvidence = {
  planAHealthy?: boolean;
  sourceBranchReviewable?: boolean;
  staticGatesGreen?: boolean;
  staticGatesReceiptPath?: string;
  jsonEvidencePreserved?: boolean;
  jsonEvidencePath?: string;
  dedicatedDb?: PostgresSessionStoreDedicatedDbEvidence;
  nonLiveIntegrationGreen?: boolean;
  nonLiveIntegrationReceiptPath?: string;
  migrationRollbackGreen?: boolean;
  migrationRollbackReceiptPath?: string;
  noAgentLoadGatewayProofGreen?: boolean;
  noAgentLoadGatewayProofReceiptPath?: string;
  admissionBackpressureProofGreen?: boolean;
  admissionBackpressureReceiptPath?: string;
  targetRuntimeProofGreen?: boolean;
  targetRuntimeProofReceiptPath?: string;
  operatorCutoverApprovalRecorded?: boolean;
  operatorCutoverApprovalReceiptPath?: string;
  c7ResumeApprovalRecorded?: boolean;
  c7ResumeApprovalReceiptPath?: string;
  c7ResumeChecklist?: PostgresSessionStoreC7ResumeChecklist;
};

export type PostgresSessionStoreRolloutDenialCode =
  | "plan_a_unhealthy"
  | "source_branch_not_reviewable"
  | "static_gates_not_green"
  | "static_gates_receipt_missing"
  | "json_evidence_not_preserved"
  | "json_evidence_path_missing"
  | "dedicated_db_approval_missing"
  | "dedicated_db_approval_receipt_missing"
  | "dedicated_session_store_url_missing"
  | "generic_database_url_forbidden"
  | "shared_cms_payload_supabase_pool_forbidden"
  | "tenant_id_missing"
  | "gateway_id_missing"
  | "schema_missing"
  | "nonlive_integration_missing"
  | "nonlive_integration_receipt_missing"
  | "migration_rollback_missing"
  | "migration_rollback_receipt_missing"
  | "no_agent_load_proof_missing"
  | "no_agent_load_proof_receipt_missing"
  | "admission_backpressure_missing"
  | "admission_backpressure_receipt_missing"
  | "target_runtime_proof_missing"
  | "target_runtime_proof_receipt_missing"
  | "operator_cutover_approval_missing"
  | "operator_cutover_approval_receipt_missing"
  | "c7_resume_approval_missing"
  | "c7_resume_approval_receipt_missing"
  | "c7_resume_checklist_incomplete";

export type PostgresSessionStoreRolloutDenial = {
  code: PostgresSessionStoreRolloutDenialCode;
  message: string;
};

export type PostgresSessionStoreRolloutGateDecision = {
  phase: PostgresSessionStoreRolloutPhase;
  allowed: boolean;
  denials: PostgresSessionStoreRolloutDenial[];
};

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function deny(
  denials: PostgresSessionStoreRolloutDenial[],
  code: PostgresSessionStoreRolloutDenialCode,
  message: string,
): void {
  denials.push({ code, message });
}

function requireStaticSourceGates(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.staticGatesGreen !== true) {
    deny(
      denials,
      "static_gates_not_green",
      "Plan B static source gates must be green before external or proof phases",
    );
  } else if (!hasText(evidence.staticGatesReceiptPath)) {
    deny(
      denials,
      "static_gates_receipt_missing",
      "Plan B static source gate receipt path must be recorded",
    );
  }
  if (evidence.jsonEvidencePreserved !== true) {
    deny(
      denials,
      "json_evidence_not_preserved",
      "JSON/session/transcript evidence must be preserved before Postgres rollout phases",
    );
  } else if (!hasText(evidence.jsonEvidencePath)) {
    deny(
      denials,
      "json_evidence_path_missing",
      "JSON/session/transcript preservation evidence path must be recorded",
    );
  }
}

function requireReviewableBranch(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.sourceBranchReviewable !== true) {
    deny(
      denials,
      "source_branch_not_reviewable",
      "Plan B source branch must be reviewable before runtime proof or C7 resume",
    );
  }
}

function requireDedicatedDbContract(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  const dedicatedDb = evidence.dedicatedDb;
  if (dedicatedDb?.approvalRecorded !== true) {
    deny(
      denials,
      "dedicated_db_approval_missing",
      "Dedicated non-live OpenClaw session-store DB approval is required",
    );
  } else if (!hasText(dedicatedDb.approvalReceiptPath)) {
    deny(
      denials,
      "dedicated_db_approval_receipt_missing",
      "Dedicated non-live OpenClaw session-store DB approval receipt path is required",
    );
  }
  if (dedicatedDb?.usesDedicatedSessionStoreUrl !== true) {
    deny(
      denials,
      "dedicated_session_store_url_missing",
      "Use OPENCLAW_SESSION_STORE_POSTGRES_URL for a dedicated session-store database",
    );
  }
  if (dedicatedDb?.usesGenericDatabaseUrl === true) {
    deny(
      denials,
      "generic_database_url_forbidden",
      "Generic DATABASE_URL must not be used for OpenClaw session-store Postgres tests",
    );
  }
  if (dedicatedDb?.sharesCmsPayloadSupabasePool === true) {
    deny(
      denials,
      "shared_cms_payload_supabase_pool_forbidden",
      "CMS/Payload/Supabase application DBs or pools must not be shared with session-store traffic",
    );
  }
  if (!hasText(dedicatedDb?.tenantId)) {
    deny(denials, "tenant_id_missing", "OPENCLAW_SESSION_STORE_TENANT_ID is required");
  }
  if (!hasText(dedicatedDb?.gatewayId)) {
    deny(denials, "gateway_id_missing", "OPENCLAW_SESSION_STORE_GATEWAY_ID is required");
  }
  if (!hasText(dedicatedDb?.schema)) {
    deny(denials, "schema_missing", "A dedicated session-store Postgres schema is required");
  }
}

function requireNonLiveIntegration(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.nonLiveIntegrationGreen !== true) {
    deny(
      denials,
      "nonlive_integration_missing",
      "Dedicated non-live Postgres session-store integration must be green",
    );
  } else if (!hasText(evidence.nonLiveIntegrationReceiptPath)) {
    deny(
      denials,
      "nonlive_integration_receipt_missing",
      "Dedicated non-live Postgres integration receipt path must be recorded",
    );
  }
}

function requireMigrationRollback(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.migrationRollbackGreen !== true) {
    deny(
      denials,
      "migration_rollback_missing",
      "Migration dry-run/apply/verify/rollback proof must be green",
    );
  } else if (!hasText(evidence.migrationRollbackReceiptPath)) {
    deny(
      denials,
      "migration_rollback_receipt_missing",
      "Migration dry-run/apply/verify/rollback receipt path must be recorded",
    );
  }
}

function requireNoAgentLoadProof(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.noAgentLoadGatewayProofGreen !== true) {
    deny(
      denials,
      "no_agent_load_proof_missing",
      "No-agent-load gateway/session-store health proof must be green",
    );
  } else if (!hasText(evidence.noAgentLoadGatewayProofReceiptPath)) {
    deny(
      denials,
      "no_agent_load_proof_receipt_missing",
      "No-agent-load gateway/session-store health proof receipt path must be recorded",
    );
  }
}

function requireAdmissionBackpressure(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.admissionBackpressureProofGreen !== true) {
    deny(
      denials,
      "admission_backpressure_missing",
      "Admission/backpressure denial proof must be green before expansion or C7 resume",
    );
  } else if (!hasText(evidence.admissionBackpressureReceiptPath)) {
    deny(
      denials,
      "admission_backpressure_receipt_missing",
      "Admission/backpressure denial proof receipt path must be recorded",
    );
  }
}

function requireTargetRuntimeProof(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.targetRuntimeProofGreen !== true) {
    deny(
      denials,
      "target_runtime_proof_missing",
      "Bounded target-runtime proof must be green before live cutover completion",
    );
  } else if (!hasText(evidence.targetRuntimeProofReceiptPath)) {
    deny(
      denials,
      "target_runtime_proof_receipt_missing",
      "Bounded target-runtime proof receipt path must be recorded",
    );
  }
}

function requireOperatorCutoverApproval(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.operatorCutoverApprovalRecorded !== true) {
    deny(
      denials,
      "operator_cutover_approval_missing",
      "Operator/integrator cutover approval must be recorded for target-runtime proof or cutover",
    );
  } else if (!hasText(evidence.operatorCutoverApprovalReceiptPath)) {
    deny(
      denials,
      "operator_cutover_approval_receipt_missing",
      "Operator/integrator cutover approval receipt path must be recorded",
    );
  }
}

function requireC7ResumeApproval(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.c7ResumeApprovalRecorded !== true) {
    deny(
      denials,
      "c7_resume_approval_missing",
      "Operator/integrator C7 resume approval must be recorded",
    );
  } else if (!hasText(evidence.c7ResumeApprovalReceiptPath)) {
    deny(
      denials,
      "c7_resume_approval_receipt_missing",
      "Operator/integrator C7 resume approval receipt path must be recorded",
    );
  }
  const checklist = evidence.c7ResumeChecklist;
  const checklistComplete =
    checklist?.exactLanes === true &&
    checklist.concurrencyBudget === true &&
    checklist.gatewayRouting === true &&
    checklist.stopCommands === true &&
    checklist.evidencePath === true;
  if (!checklistComplete) {
    deny(
      denials,
      "c7_resume_checklist_incomplete",
      "C7 resume checklist must name exact lanes, concurrency budget, gateway routing, stop commands, and evidence path",
    );
  }
}

function requirePlanAHealthy(
  denials: PostgresSessionStoreRolloutDenial[],
  evidence: PostgresSessionStoreRolloutEvidence,
): void {
  if (evidence.planAHealthy !== true) {
    deny(
      denials,
      "plan_a_unhealthy",
      "Plan A gateway containment health must be green before C7 resume",
    );
  }
}

export function evaluatePostgresSessionStoreRolloutGate(
  phase: PostgresSessionStoreRolloutPhase,
  evidence: PostgresSessionStoreRolloutEvidence,
): PostgresSessionStoreRolloutGateDecision {
  const denials: PostgresSessionStoreRolloutDenial[] = [];

  requireStaticSourceGates(denials, evidence);

  if (
    phase === "nonlive-integration" ||
    phase === "migration-rollback-proof" ||
    phase === "no-agent-load-proof" ||
    phase === "target-runtime-proof" ||
    phase === "c7-resume"
  ) {
    requireDedicatedDbContract(denials, evidence);
  }

  if (
    phase === "migration-rollback-proof" ||
    phase === "no-agent-load-proof" ||
    phase === "target-runtime-proof" ||
    phase === "c7-resume"
  ) {
    requireNonLiveIntegration(denials, evidence);
  }

  if (
    phase === "no-agent-load-proof" ||
    phase === "target-runtime-proof" ||
    phase === "c7-resume"
  ) {
    requireMigrationRollback(denials, evidence);
  }

  if (phase === "target-runtime-proof" || phase === "c7-resume") {
    requireNoAgentLoadProof(denials, evidence);
    requireAdmissionBackpressure(denials, evidence);
  }

  if (phase === "target-runtime-proof") {
    requireReviewableBranch(denials, evidence);
    requireOperatorCutoverApproval(denials, evidence);
  }

  if (phase === "c7-resume") {
    requirePlanAHealthy(denials, evidence);
    requireReviewableBranch(denials, evidence);
    requireC7ResumeApproval(denials, evidence);
  }

  return {
    phase,
    allowed: denials.length === 0,
    denials,
  };
}

export function evaluatePostgresSessionStoreCompletionGate(
  evidence: PostgresSessionStoreRolloutEvidence,
): PostgresSessionStoreRolloutGateDecision {
  const decision = evaluatePostgresSessionStoreRolloutGate("target-runtime-proof", evidence);
  const denials = [...decision.denials];
  requireTargetRuntimeProof(denials, evidence);
  return {
    phase: "target-runtime-proof",
    allowed: denials.length === 0,
    denials,
  };
}
