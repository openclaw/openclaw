import {
  readPostgresSessionStoreRuntimeConfig,
  type PostgresSessionStoreRuntimeConfig,
} from "./postgres-runtime-config.js";

export type PostgresSessionStoreRuntimeProofPhase = "no-agent-load-proof" | "target-runtime-proof";

export type PostgresSessionStoreRuntimeProofCommand = {
  argv: readonly string[];
  cwd?: string;
};

export type PostgresSessionStoreRuntimeProofGatewayProfile = {
  port?: number;
  configPath?: string;
  stateDir?: string;
  sessionDir?: string;
  workspaceDir?: string;
  logPath?: string;
  sessionStorePath?: string;
  readinessProbePath?: string;
  startupSettlePlan?: string;
  rpcTimeoutMs?: number;
};

export type PostgresSessionStoreRuntimeProofPreflightEvidence = {
  staticGatesGreen?: boolean;
  staticGatesReceiptPath?: string;
  jsonEvidencePreserved?: boolean;
  jsonEvidencePath?: string;
  nonLiveIntegrationGreen?: boolean;
  nonLiveIntegrationReceiptPath?: string;
  migrationRollbackGreen?: boolean;
  migrationRollbackReceiptPath?: string;
  noAgentLoadGatewayProofGreen?: boolean;
  noAgentLoadGatewayProofReceiptPath?: string;
  admissionBackpressureProofGreen?: boolean;
  admissionBackpressureReceiptPath?: string;
  operatorCutoverApprovalRecorded?: boolean;
  operatorCutoverApprovalReceiptPath?: string;
  externalWritesDisabled?: boolean;
  declaresNoAgentLoad?: boolean;
  noControllersPublishersPollersAutomations?: boolean;
};

export type PostgresSessionStoreRuntimeProofPreflightInput = {
  phase: PostgresSessionStoreRuntimeProofPhase;
  env: Record<string, string | undefined>;
  evidence: PostgresSessionStoreRuntimeProofPreflightEvidence;
  command?: PostgresSessionStoreRuntimeProofCommand;
  stopCommand?: PostgresSessionStoreRuntimeProofCommand;
  gateway?: PostgresSessionStoreRuntimeProofGatewayProfile;
  evidencePath?: string;
  forbiddenPorts?: readonly number[];
};

export type PostgresSessionStoreRuntimeProofPreflightDenialCode =
  | "runtime_config_invalid"
  | "static_gates_not_green"
  | "json_evidence_not_preserved"
  | "nonlive_integration_missing"
  | "migration_rollback_missing"
  | "no_agent_load_declaration_missing"
  | "controllers_publishers_pollers_automation_declaration_missing"
  | "no_agent_load_proof_missing"
  | "admission_backpressure_missing"
  | "operator_cutover_approval_missing"
  | "external_writes_not_disabled"
  | "command_missing"
  | "stop_command_missing"
  | "forbidden_command_token"
  | "gateway_port_missing"
  | "gateway_port_forbidden"
  | "config_path_missing"
  | "state_dir_missing"
  | "session_dir_missing"
  | "workspace_dir_missing"
  | "log_path_missing"
  | "evidence_path_missing"
  | "static_gates_receipt_missing"
  | "json_evidence_path_missing"
  | "nonlive_integration_receipt_missing"
  | "migration_rollback_receipt_missing"
  | "no_agent_load_proof_receipt_missing"
  | "admission_backpressure_receipt_missing"
  | "operator_cutover_approval_receipt_missing"
  | "session_store_path_missing"
  | "session_store_path_not_isolated"
  | "readiness_probe_not_readyz"
  | "startup_settle_plan_missing"
  | "postgres_connection_timeout_too_low"
  | "postgres_statement_timeout_too_low"
  | "rpc_timeout_too_low";

export type PostgresSessionStoreRuntimeProofPreflightDenial = {
  code: PostgresSessionStoreRuntimeProofPreflightDenialCode;
  message: string;
  observed?: unknown;
};

export type PostgresSessionStoreRuntimeProofPreflightDecision = {
  phase: PostgresSessionStoreRuntimeProofPhase;
  allowed: boolean;
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[];
  runtimeConfig?: PostgresSessionStoreRuntimeConfig;
};

const FORBIDDEN_COMMAND_TOKENS = [
  "c7",
  "c7.5",
  "controller",
  "publisher",
  "poller",
  "automation",
  "agent-load",
  "chat.send",
  "sessions.send",
  "dispatch-runner",
] as const;

const MIN_PROOF_POSTGRES_TIMEOUT_MS = 30_000;
const MIN_PROOF_RPC_TIMEOUT_MS = 60_000;

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deny(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  code: PostgresSessionStoreRuntimeProofPreflightDenialCode,
  message: string,
  observed?: unknown,
): void {
  denials.push({
    code,
    message,
    ...(observed !== undefined ? { observed } : {}),
  });
}

function requireCommonEvidence(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  evidence: PostgresSessionStoreRuntimeProofPreflightEvidence,
): void {
  if (evidence.staticGatesGreen !== true) {
    deny(denials, "static_gates_not_green", "Plan B static source gates must be green");
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
      "JSON/session/transcript evidence preservation must be recorded",
    );
  } else if (!hasText(evidence.jsonEvidencePath)) {
    deny(
      denials,
      "json_evidence_path_missing",
      "JSON/session/transcript preservation evidence path must be recorded",
    );
  }
  if (evidence.nonLiveIntegrationGreen !== true) {
    deny(
      denials,
      "nonlive_integration_missing",
      "Dedicated non-live Postgres integration must be green before runtime proof",
    );
  } else if (!hasText(evidence.nonLiveIntegrationReceiptPath)) {
    deny(
      denials,
      "nonlive_integration_receipt_missing",
      "Dedicated non-live Postgres integration receipt path must be recorded",
    );
  }
  if (evidence.migrationRollbackGreen !== true) {
    deny(
      denials,
      "migration_rollback_missing",
      "Migration dry-run/apply/verify/rollback proof must be green before runtime proof",
    );
  } else if (!hasText(evidence.migrationRollbackReceiptPath)) {
    deny(
      denials,
      "migration_rollback_receipt_missing",
      "Migration dry-run/apply/verify/rollback receipt path must be recorded",
    );
  }
}

function requireNoAgentLoadEvidence(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  evidence: PostgresSessionStoreRuntimeProofPreflightEvidence,
): void {
  if (evidence.declaresNoAgentLoad !== true) {
    deny(
      denials,
      "no_agent_load_declaration_missing",
      "No-agent-load proof must explicitly declare that no OpenClaw agent turns/model/tool calls will run",
    );
  }
  if (evidence.noControllersPublishersPollersAutomations !== true) {
    deny(
      denials,
      "controllers_publishers_pollers_automation_declaration_missing",
      "Runtime proof must explicitly disable controllers, publishers, pollers, and automations",
    );
  }
}

function requireTargetRuntimeEvidence(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  evidence: PostgresSessionStoreRuntimeProofPreflightEvidence,
): void {
  if (evidence.noAgentLoadGatewayProofGreen !== true) {
    deny(
      denials,
      "no_agent_load_proof_missing",
      "No-agent-load gateway/session-store proof must be green before target-runtime proof",
    );
  } else if (!hasText(evidence.noAgentLoadGatewayProofReceiptPath)) {
    deny(
      denials,
      "no_agent_load_proof_receipt_missing",
      "No-agent-load gateway/session-store proof receipt path must be recorded",
    );
  }
  if (evidence.admissionBackpressureProofGreen !== true) {
    deny(
      denials,
      "admission_backpressure_missing",
      "Admission/backpressure proof must be green before target-runtime proof",
    );
  } else if (!hasText(evidence.admissionBackpressureReceiptPath)) {
    deny(
      denials,
      "admission_backpressure_receipt_missing",
      "Admission/backpressure proof receipt path must be recorded",
    );
  }
  if (evidence.operatorCutoverApprovalRecorded !== true) {
    deny(
      denials,
      "operator_cutover_approval_missing",
      "Operator/integrator cutover approval must be recorded before target-runtime proof",
    );
  } else if (!hasText(evidence.operatorCutoverApprovalReceiptPath)) {
    deny(
      denials,
      "operator_cutover_approval_receipt_missing",
      "Operator/integrator cutover approval receipt path must be recorded",
    );
  }
  if (evidence.externalWritesDisabled !== true) {
    deny(
      denials,
      "external_writes_not_disabled",
      "Target-runtime proof must explicitly disable CMS/social/email/external writes",
    );
  }
}

function commandTokens(command: PostgresSessionStoreRuntimeProofCommand | undefined): string[] {
  return command?.argv.map((part) => part.toLowerCase()) ?? [];
}

function requireCommands(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  input: Pick<PostgresSessionStoreRuntimeProofPreflightInput, "command" | "stopCommand">,
): void {
  if (!input.command || input.command.argv.length === 0) {
    deny(denials, "command_missing", "Runtime proof command must be recorded before launch");
  }
  if (!input.stopCommand || input.stopCommand.argv.length === 0) {
    deny(
      denials,
      "stop_command_missing",
      "Exact runtime proof stop command must be recorded before launch",
    );
  }
  const tokens = [...commandTokens(input.command), ...commandTokens(input.stopCommand)];
  for (const token of tokens) {
    const forbidden = FORBIDDEN_COMMAND_TOKENS.find((candidate) => token.includes(candidate));
    if (forbidden) {
      deny(
        denials,
        "forbidden_command_token",
        "Runtime proof command mentions a forbidden C7/agent-load/controller/publisher/poller/automation token",
        token,
      );
    }
  }
}

function requireGatewayProfile(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  input: Pick<
    PostgresSessionStoreRuntimeProofPreflightInput,
    "gateway" | "evidencePath" | "forbiddenPorts"
  >,
): void {
  const gateway = input.gateway;
  const port = gateway?.port;
  if (typeof port !== "number" || !Number.isFinite(port) || port < 1 || port > 65_535) {
    deny(denials, "gateway_port_missing", "Exact isolated gateway port must be recorded", port);
  } else if (input.forbiddenPorts?.includes(port)) {
    deny(
      denials,
      "gateway_port_forbidden",
      "Runtime proof gateway port conflicts with a forbidden/live port",
      port,
    );
  }
  if (!hasText(gateway?.configPath)) {
    deny(denials, "config_path_missing", "Exact OPENCLAW_CONFIG_PATH must be recorded");
  }
  if (!hasText(gateway?.stateDir)) {
    deny(denials, "state_dir_missing", "Exact OPENCLAW_STATE_DIR must be recorded");
  }
  if (!hasText(gateway?.sessionDir)) {
    deny(denials, "session_dir_missing", "Exact isolated agent/session directory must be recorded");
  }
  if (!hasText(gateway?.workspaceDir)) {
    deny(denials, "workspace_dir_missing", "Exact isolated workspace directory must be recorded");
  }
  if (!hasText(gateway?.logPath)) {
    deny(denials, "log_path_missing", "Exact runtime proof log path must be recorded");
  }
  if (!hasText(input.evidencePath)) {
    deny(denials, "evidence_path_missing", "Runtime proof evidence path must be recorded");
  }
  if (!hasText(gateway?.sessionStorePath)) {
    deny(
      denials,
      "session_store_path_missing",
      "Exact isolated session-store path must be recorded",
    );
  } else if (
    hasText(gateway?.sessionDir) &&
    !gateway.sessionStorePath.startsWith(gateway.sessionDir)
  ) {
    deny(
      denials,
      "session_store_path_not_isolated",
      "Session store path must live under the isolated session directory; no shared sessions.json",
      gateway.sessionStorePath,
    );
  }
}

function requireCorrectedHarness(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  input: Pick<PostgresSessionStoreRuntimeProofPreflightInput, "gateway">,
  runtimeConfig: PostgresSessionStoreRuntimeConfig | undefined,
): void {
  const gateway = input.gateway;
  if (gateway?.readinessProbePath !== "/readyz") {
    deny(
      denials,
      "readiness_probe_not_readyz",
      "Runtime proof harness must wait for /readyz readiness; /healthz is liveness only",
      gateway?.readinessProbePath,
    );
  }
  if (!hasText(gateway?.startupSettlePlan)) {
    deny(
      denials,
      "startup_settle_plan_missing",
      "Runtime proof harness must record provider-auth/plugin startup-settle plan before first storage RPC",
    );
  }
  const rpcTimeoutMs = gateway?.rpcTimeoutMs;
  if (
    typeof rpcTimeoutMs !== "number" ||
    !Number.isFinite(rpcTimeoutMs) ||
    rpcTimeoutMs < MIN_PROOF_RPC_TIMEOUT_MS
  ) {
    deny(
      denials,
      "rpc_timeout_too_low",
      `Runtime proof storage RPC timeout must be >= ${MIN_PROOF_RPC_TIMEOUT_MS}ms`,
      rpcTimeoutMs,
    );
  }
  if (runtimeConfig?.enabled !== true) {
    return;
  }
  if (runtimeConfig.pool.connectionTimeoutMs < MIN_PROOF_POSTGRES_TIMEOUT_MS) {
    deny(
      denials,
      "postgres_connection_timeout_too_low",
      `Runtime proof Postgres connection timeout must be >= ${MIN_PROOF_POSTGRES_TIMEOUT_MS}ms`,
      runtimeConfig.pool.connectionTimeoutMs,
    );
  }
  if (runtimeConfig.pool.statementTimeoutMs < MIN_PROOF_POSTGRES_TIMEOUT_MS) {
    deny(
      denials,
      "postgres_statement_timeout_too_low",
      `Runtime proof Postgres statement timeout must be >= ${MIN_PROOF_POSTGRES_TIMEOUT_MS}ms`,
      runtimeConfig.pool.statementTimeoutMs,
    );
  }
}

function readRuntimeConfigDecision(
  denials: PostgresSessionStoreRuntimeProofPreflightDenial[],
  env: Record<string, string | undefined>,
): PostgresSessionStoreRuntimeConfig | undefined {
  try {
    const config = readPostgresSessionStoreRuntimeConfig(env);
    if (!config.enabled) {
      deny(denials, "runtime_config_invalid", config.reason);
    }
    return config;
  } catch (error) {
    deny(
      denials,
      "runtime_config_invalid",
      error instanceof Error ? error.message : "Invalid Postgres session-store runtime config",
    );
    return undefined;
  }
}

export function evaluatePostgresSessionStoreRuntimeProofPreflight(
  input: PostgresSessionStoreRuntimeProofPreflightInput,
): PostgresSessionStoreRuntimeProofPreflightDecision {
  const denials: PostgresSessionStoreRuntimeProofPreflightDenial[] = [];
  const runtimeConfig = readRuntimeConfigDecision(denials, input.env);
  requireCommonEvidence(denials, input.evidence);
  requireCommands(denials, input);
  requireGatewayProfile(denials, input);
  requireCorrectedHarness(denials, input, runtimeConfig);
  if (input.phase === "no-agent-load-proof") {
    requireNoAgentLoadEvidence(denials, input.evidence);
  } else {
    requireTargetRuntimeEvidence(denials, input.evidence);
  }

  return {
    phase: input.phase,
    allowed: denials.length === 0,
    denials,
    ...(runtimeConfig ? { runtimeConfig } : {}),
  };
}
