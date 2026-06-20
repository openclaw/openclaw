import { describe, expect, it } from "vitest";
import {
  evaluatePostgresSessionStoreCompletionGate,
  evaluatePostgresSessionStoreRolloutGate,
  type PostgresSessionStoreRolloutEvidence,
} from "./postgres-rollout-gate.js";

function greenDedicatedDb(): Required<PostgresSessionStoreRolloutEvidence>["dedicatedDb"] {
  return {
    approvalRecorded: true,
    approvalReceiptPath: "/receipts/dedicated-db-approval.md",
    usesDedicatedSessionStoreUrl: true,
    usesGenericDatabaseUrl: false,
    sharesCmsPayloadSupabasePool: false,
    tenantId: "type0-plan-b-nonlive",
    gatewayId: "plan-b-integration",
    schema: "openclaw_session_store_test",
  };
}

function baseEvidence(
  overrides: PostgresSessionStoreRolloutEvidence = {},
): PostgresSessionStoreRolloutEvidence {
  return {
    staticGatesGreen: true,
    staticGatesReceiptPath: "/receipts/static-gates.md",
    jsonEvidencePreserved: true,
    jsonEvidencePath: "/receipts/json-evidence-preserved.md",
    dedicatedDb: greenDedicatedDb(),
    ...overrides,
  };
}

describe("postgres session-store rollout gate", () => {
  it("fails closed before non-live integration when source gates or dedicated DB contract are missing", () => {
    const decision = evaluatePostgresSessionStoreRolloutGate("nonlive-integration", {
      staticGatesGreen: false,
      jsonEvidencePreserved: false,
      dedicatedDb: {
        approvalRecorded: false,
        usesDedicatedSessionStoreUrl: false,
        usesGenericDatabaseUrl: true,
        sharesCmsPayloadSupabasePool: true,
      },
    });

    expect(decision).toMatchObject({
      allowed: false,
      denials: [
        expect.objectContaining({ code: "static_gates_not_green" }),
        expect.objectContaining({ code: "json_evidence_not_preserved" }),
        expect.objectContaining({ code: "dedicated_db_approval_missing" }),
        expect.objectContaining({ code: "dedicated_session_store_url_missing" }),
        expect.objectContaining({ code: "generic_database_url_forbidden" }),
        expect.objectContaining({ code: "shared_cms_payload_supabase_pool_forbidden" }),
        expect.objectContaining({ code: "tenant_id_missing" }),
        expect.objectContaining({ code: "gateway_id_missing" }),
        expect.objectContaining({ code: "schema_missing" }),
      ],
    });
  });

  it("allows non-live integration only after the dedicated DB and static preflight contract is satisfied", () => {
    expect(
      evaluatePostgresSessionStoreRolloutGate("nonlive-integration", baseEvidence()),
    ).toMatchObject({
      allowed: true,
      denials: [],
    });
  });

  it("requires ordered predecessor receipts before migration and no-agent-load proof phases", () => {
    expect(
      evaluatePostgresSessionStoreRolloutGate("migration-rollback-proof", baseEvidence()),
    ).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "nonlive_integration_missing" })],
    });

    expect(
      evaluatePostgresSessionStoreRolloutGate(
        "no-agent-load-proof",
        baseEvidence({
          nonLiveIntegrationGreen: true,
          nonLiveIntegrationReceiptPath: "/receipts/nonlive-integration.md",
        }),
      ),
    ).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "migration_rollback_missing" })],
    });
  });

  it("denies claimed-green receipts without exact receipt paths", () => {
    const dedicatedDb = greenDedicatedDb();
    delete dedicatedDb.approvalReceiptPath;
    const evidence = baseEvidence({
      dedicatedDb,
      sourceBranchReviewable: true,
      nonLiveIntegrationGreen: true,
      migrationRollbackGreen: true,
      noAgentLoadGatewayProofGreen: true,
      admissionBackpressureProofGreen: true,
      operatorCutoverApprovalRecorded: true,
    });
    delete evidence.staticGatesReceiptPath;
    delete evidence.jsonEvidencePath;
    const decision = evaluatePostgresSessionStoreRolloutGate("target-runtime-proof", evidence);

    expect(decision).toMatchObject({
      allowed: false,
      denials: expect.arrayContaining([
        expect.objectContaining({ code: "static_gates_receipt_missing" }),
        expect.objectContaining({ code: "json_evidence_path_missing" }),
        expect.objectContaining({ code: "dedicated_db_approval_receipt_missing" }),
        expect.objectContaining({ code: "nonlive_integration_receipt_missing" }),
        expect.objectContaining({ code: "migration_rollback_receipt_missing" }),
        expect.objectContaining({ code: "no_agent_load_proof_receipt_missing" }),
        expect.objectContaining({ code: "admission_backpressure_receipt_missing" }),
        expect.objectContaining({ code: "operator_cutover_approval_receipt_missing" }),
      ]),
    });
  });

  it("requires cutover approval and target runtime proof before completion is allowed", () => {
    const preTarget = baseEvidence({
      sourceBranchReviewable: true,
      nonLiveIntegrationGreen: true,
      nonLiveIntegrationReceiptPath: "/receipts/nonlive-integration.md",
      migrationRollbackGreen: true,
      migrationRollbackReceiptPath: "/receipts/migration-rollback.md",
      noAgentLoadGatewayProofGreen: true,
      noAgentLoadGatewayProofReceiptPath: "/receipts/no-agent-load.md",
      admissionBackpressureProofGreen: true,
      admissionBackpressureReceiptPath: "/receipts/admission-backpressure.md",
    });

    expect(
      evaluatePostgresSessionStoreRolloutGate("target-runtime-proof", preTarget),
    ).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "operator_cutover_approval_missing" })],
    });

    expect(
      evaluatePostgresSessionStoreCompletionGate({
        ...preTarget,
        operatorCutoverApprovalRecorded: true,
        operatorCutoverApprovalReceiptPath: "/receipts/operator-cutover.md",
      }),
    ).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "target_runtime_proof_missing" })],
    });

    expect(
      evaluatePostgresSessionStoreCompletionGate({
        ...preTarget,
        operatorCutoverApprovalRecorded: true,
        operatorCutoverApprovalReceiptPath: "/receipts/operator-cutover.md",
        targetRuntimeProofGreen: true,
        targetRuntimeProofReceiptPath: "/receipts/target-runtime.md",
      }),
    ).toMatchObject({ allowed: true, denials: [] });
  });

  it("keeps C7 resume denied until every runbook gate and exact resume checklist item is recorded", () => {
    const missingChecklist = evaluatePostgresSessionStoreRolloutGate(
      "c7-resume",
      baseEvidence({
        planAHealthy: true,
        sourceBranchReviewable: true,
        nonLiveIntegrationGreen: true,
        nonLiveIntegrationReceiptPath: "/receipts/nonlive-integration.md",
        migrationRollbackGreen: true,
        migrationRollbackReceiptPath: "/receipts/migration-rollback.md",
        noAgentLoadGatewayProofGreen: true,
        noAgentLoadGatewayProofReceiptPath: "/receipts/no-agent-load.md",
        admissionBackpressureProofGreen: true,
        admissionBackpressureReceiptPath: "/receipts/admission-backpressure.md",
        c7ResumeApprovalRecorded: true,
        c7ResumeApprovalReceiptPath: "/receipts/c7-resume-approval.md",
        c7ResumeChecklist: {
          exactLanes: true,
          concurrencyBudget: true,
          gatewayRouting: true,
          stopCommands: true,
          evidencePath: false,
        },
      }),
    );

    expect(missingChecklist).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "c7_resume_checklist_incomplete" })],
    });

    const allowed = evaluatePostgresSessionStoreRolloutGate(
      "c7-resume",
      baseEvidence({
        planAHealthy: true,
        sourceBranchReviewable: true,
        nonLiveIntegrationGreen: true,
        nonLiveIntegrationReceiptPath: "/receipts/nonlive-integration.md",
        migrationRollbackGreen: true,
        migrationRollbackReceiptPath: "/receipts/migration-rollback.md",
        noAgentLoadGatewayProofGreen: true,
        noAgentLoadGatewayProofReceiptPath: "/receipts/no-agent-load.md",
        admissionBackpressureProofGreen: true,
        admissionBackpressureReceiptPath: "/receipts/admission-backpressure.md",
        c7ResumeApprovalRecorded: true,
        c7ResumeApprovalReceiptPath: "/receipts/c7-resume-approval.md",
        c7ResumeChecklist: {
          exactLanes: true,
          concurrencyBudget: true,
          gatewayRouting: true,
          stopCommands: true,
          evidencePath: true,
        },
      }),
    );

    expect(allowed).toMatchObject({ allowed: true, denials: [] });
  });
});
