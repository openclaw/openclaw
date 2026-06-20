import { describe, expect, it } from "vitest";
import {
  SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_POOL_MAX_ENV,
  SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_URL_ENV,
} from "./postgres-runtime-config.js";
import {
  evaluatePostgresSessionStoreRuntimeProofPreflight,
  type PostgresSessionStoreRuntimeProofPreflightInput,
} from "./postgres-runtime-proof-preflight.js";
import {
  SESSION_STORE_BACKEND_ENV,
  SESSION_STORE_GATEWAY_ID_ENV,
  SESSION_STORE_SCHEMA_ENV,
  SESSION_STORE_TENANT_ID_ENV,
} from "./store-async.js";

function dedicatedEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [SESSION_STORE_BACKEND_ENV]: "postgres",
    [SESSION_STORE_TENANT_ID_ENV]: "type0",
    [SESSION_STORE_GATEWAY_ID_ENV]: "type0-eval-proof",
    [SESSION_STORE_SCHEMA_ENV]: "openclaw_session_store_nonlive",
    [SESSION_STORE_POSTGRES_URL_ENV]:
      "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
    [SESSION_STORE_POSTGRES_POOL_MAX_ENV]: "4",
    [SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV]: "30000",
    [SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV]: "30000",
    ...overrides,
  };
}

function validGateway() {
  return {
    port: 18_990,
    configPath: "/tmp/openclaw-plan-b/config/openclaw.json",
    stateDir: "/tmp/openclaw-plan-b/state",
    sessionDir: "/tmp/openclaw-plan-b/sessions",
    workspaceDir: "/tmp/openclaw-plan-b/workspace",
    logPath: "/tmp/openclaw-plan-b/logs/gateway.log",
    sessionStorePath: "/tmp/openclaw-plan-b/sessions/sessions.json",
    readinessProbePath: "/readyz",
    startupSettlePlan: "wait for provider-auth prewarm log or bounded startup settle",
    rpcTimeoutMs: 60_000,
  };
}

function validInput(
  overrides: Partial<PostgresSessionStoreRuntimeProofPreflightInput> = {},
): PostgresSessionStoreRuntimeProofPreflightInput & {
  evidence: NonNullable<PostgresSessionStoreRuntimeProofPreflightInput["evidence"]>;
} {
  return {
    phase: "no-agent-load-proof",
    env: dedicatedEnv(),
    command: { argv: ["openclaw", "gateway", "start", "--port", "18990"] },
    stopCommand: { argv: ["openclaw", "gateway", "stop", "--port", "18990"] },
    gateway: validGateway(),
    evidencePath: "/tmp/openclaw-plan-b/receipts/no-agent-load.md",
    forbiddenPorts: [18789, 18790],
    evidence: {
      staticGatesGreen: true,
      staticGatesReceiptPath: "/tmp/openclaw-plan-b/receipts/static-gates.md",
      jsonEvidencePreserved: true,
      jsonEvidencePath: "/tmp/openclaw-plan-b/receipts/json-preserved.md",
      nonLiveIntegrationGreen: true,
      nonLiveIntegrationReceiptPath: "/tmp/openclaw-plan-b/receipts/nonlive-integration.md",
      migrationRollbackGreen: true,
      migrationRollbackReceiptPath: "/tmp/openclaw-plan-b/receipts/migration-rollback.md",
      declaresNoAgentLoad: true,
      noControllersPublishersPollersAutomations: true,
    },
    ...overrides,
  };
}

describe("Postgres session-store runtime proof preflight", () => {
  it("allows a no-agent-load proof only after explicit isolated runtime inputs are recorded", () => {
    expect(evaluatePostgresSessionStoreRuntimeProofPreflight(validInput())).toMatchObject({
      phase: "no-agent-load-proof",
      allowed: true,
      denials: [],
      runtimeConfig: {
        enabled: true,
        tenantId: "type0",
        gatewayId: "type0-eval-proof",
        schema: "openclaw_session_store_nonlive",
      },
    });
  });

  it("fails closed for missing runtime config, missing commands, missing paths, and missing proof declarations", () => {
    const decision = evaluatePostgresSessionStoreRuntimeProofPreflight({
      phase: "no-agent-load-proof",
      env: {},
      evidence: {},
    });

    expect(decision).toMatchObject({
      allowed: false,
      denials: [
        expect.objectContaining({ code: "runtime_config_invalid" }),
        expect.objectContaining({ code: "static_gates_not_green" }),
        expect.objectContaining({ code: "json_evidence_not_preserved" }),
        expect.objectContaining({ code: "nonlive_integration_missing" }),
        expect.objectContaining({ code: "migration_rollback_missing" }),
        expect.objectContaining({ code: "command_missing" }),
        expect.objectContaining({ code: "stop_command_missing" }),
        expect.objectContaining({ code: "gateway_port_missing" }),
        expect.objectContaining({ code: "config_path_missing" }),
        expect.objectContaining({ code: "state_dir_missing" }),
        expect.objectContaining({ code: "session_dir_missing" }),
        expect.objectContaining({ code: "workspace_dir_missing" }),
        expect.objectContaining({ code: "log_path_missing" }),
        expect.objectContaining({ code: "evidence_path_missing" }),
        expect.objectContaining({ code: "session_store_path_missing" }),
        expect.objectContaining({ code: "readiness_probe_not_readyz" }),
        expect.objectContaining({ code: "startup_settle_plan_missing" }),
        expect.objectContaining({ code: "rpc_timeout_too_low" }),
        expect.objectContaining({ code: "no_agent_load_declaration_missing" }),
        expect.objectContaining({
          code: "controllers_publishers_pollers_automation_declaration_missing",
        }),
      ],
    });
  });

  it("denies forbidden live ports, shared session-store paths, and C7/controller/publisher commands", () => {
    const decision = evaluatePostgresSessionStoreRuntimeProofPreflight(
      validInput({
        command: { argv: ["openclaw", "c7-controller", "publisher"] },
        stopCommand: { argv: ["openclaw", "automation", "stop"] },
        gateway: {
          ...validGateway(),
          port: 18789,
          sessionStorePath: "/Users/claw1/.openclaw/sessions.json",
        },
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      denials: expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_command_token" }),
        expect.objectContaining({ code: "gateway_port_forbidden", observed: 18789 }),
        expect.objectContaining({ code: "session_store_path_not_isolated" }),
      ]),
    });
    expect(
      decision.denials.filter((denial) => denial.code === "forbidden_command_token").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("denies stale timeout debug harness settings before launch", () => {
    const decision = evaluatePostgresSessionStoreRuntimeProofPreflight(
      validInput({
        env: dedicatedEnv({
          [SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV]: "2000",
          [SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV]: "5000",
        }),
        gateway: {
          ...validGateway(),
          readinessProbePath: "/healthz",
          startupSettlePlan: "",
          rpcTimeoutMs: 10_000,
        },
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      denials: expect.arrayContaining([
        expect.objectContaining({ code: "readiness_probe_not_readyz", observed: "/healthz" }),
        expect.objectContaining({ code: "startup_settle_plan_missing" }),
        expect.objectContaining({ code: "rpc_timeout_too_low", observed: 10_000 }),
        expect.objectContaining({ code: "postgres_connection_timeout_too_low", observed: 2000 }),
        expect.objectContaining({ code: "postgres_statement_timeout_too_low", observed: 5000 }),
      ]),
    });
  });

  it("denies claimed-green predecessor proofs without exact receipt paths", () => {
    const { sessionStorePath: _sessionStorePath, ...gatewayWithoutSessionStorePath } =
      validGateway();
    const decision = evaluatePostgresSessionStoreRuntimeProofPreflight(
      validInput({
        gateway: gatewayWithoutSessionStorePath,
        evidence: {
          staticGatesGreen: true,
          jsonEvidencePreserved: true,
          nonLiveIntegrationGreen: true,
          migrationRollbackGreen: true,
          declaresNoAgentLoad: true,
          noControllersPublishersPollersAutomations: true,
        },
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      denials: expect.arrayContaining([
        expect.objectContaining({ code: "static_gates_receipt_missing" }),
        expect.objectContaining({ code: "json_evidence_path_missing" }),
        expect.objectContaining({ code: "nonlive_integration_receipt_missing" }),
        expect.objectContaining({ code: "migration_rollback_receipt_missing" }),
        expect.objectContaining({ code: "session_store_path_missing" }),
      ]),
    });
  });

  it("requires target-runtime predecessor proofs, cutover approval, and external writes disabled", () => {
    const decision = evaluatePostgresSessionStoreRuntimeProofPreflight(
      validInput({
        phase: "target-runtime-proof",
        evidence: {
          staticGatesGreen: true,
          staticGatesReceiptPath: "/tmp/openclaw-plan-b/receipts/static-gates.md",
          jsonEvidencePreserved: true,
          jsonEvidencePath: "/tmp/openclaw-plan-b/receipts/json-preserved.md",
          nonLiveIntegrationGreen: true,
          nonLiveIntegrationReceiptPath: "/tmp/openclaw-plan-b/receipts/nonlive-integration.md",
          migrationRollbackGreen: true,
          migrationRollbackReceiptPath: "/tmp/openclaw-plan-b/receipts/migration-rollback.md",
          noAgentLoadGatewayProofGreen: false,
          admissionBackpressureProofGreen: false,
          operatorCutoverApprovalRecorded: false,
          externalWritesDisabled: false,
        },
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      denials: [
        expect.objectContaining({ code: "no_agent_load_proof_missing" }),
        expect.objectContaining({ code: "admission_backpressure_missing" }),
        expect.objectContaining({ code: "operator_cutover_approval_missing" }),
        expect.objectContaining({ code: "external_writes_not_disabled" }),
      ],
    });

    expect(
      evaluatePostgresSessionStoreRuntimeProofPreflight(
        validInput({
          phase: "target-runtime-proof",
          evidence: {
            staticGatesGreen: true,
            staticGatesReceiptPath: "/tmp/openclaw-plan-b/receipts/static-gates.md",
            jsonEvidencePreserved: true,
            jsonEvidencePath: "/tmp/openclaw-plan-b/receipts/json-preserved.md",
            nonLiveIntegrationGreen: true,
            nonLiveIntegrationReceiptPath: "/tmp/openclaw-plan-b/receipts/nonlive-integration.md",
            migrationRollbackGreen: true,
            migrationRollbackReceiptPath: "/tmp/openclaw-plan-b/receipts/migration-rollback.md",
            noAgentLoadGatewayProofGreen: true,
            noAgentLoadGatewayProofReceiptPath: "/tmp/openclaw-plan-b/receipts/no-agent-load.md",
            admissionBackpressureProofGreen: true,
            admissionBackpressureReceiptPath:
              "/tmp/openclaw-plan-b/receipts/admission-backpressure.md",
            operatorCutoverApprovalRecorded: true,
            operatorCutoverApprovalReceiptPath: "/tmp/openclaw-plan-b/receipts/operator-cutover.md",
            externalWritesDisabled: true,
          },
        }),
      ),
    ).toMatchObject({ allowed: true, denials: [] });
  });

  it("inherits runtime config protections against generic app database reuse", () => {
    expect(
      evaluatePostgresSessionStoreRuntimeProofPreflight(
        validInput({
          env: dedicatedEnv({
            DATABASE_URL:
              "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
          }),
        }),
      ),
    ).toMatchObject({
      allowed: false,
      denials: [expect.objectContaining({ code: "runtime_config_invalid" })],
    });
  });
});
