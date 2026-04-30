import path from "node:path";
import { auditPolicyDecision } from "./action-sink-audit.js";
import type { ActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import {
  createMissionControlActionSinkPolicyFixture,
  parseActionSinkPolicyConfig,
} from "./action-sink-policy-config.js";
import type { PolicyModule, PolicyRequest, PolicyResult } from "./action-sink-policy.js";
import {
  evaluateActionSinkPolicy,
  policyResult,
  summarizePolicyPayload,
} from "./action-sink-policy.js";
import { classifyShellCommand } from "./action-sink-shell-policy.js";
import { createEvidenceGatePolicyModule } from "./completion-claim-policy.js";
import { createExternalActionFirewallModule } from "./external-action-firewall.js";
import { createProtectedWorktreePolicyModule } from "./protected-worktree-policy.js";

export type ActionSinkEnforcementOptions = {
  config?: ActionSinkPolicyConfig;
  modules?: PolicyModule[];
  auditPath?: string;
};

let testingOverride: ActionSinkEnforcementOptions | null = null;

function createShellRiskPolicyModule(): PolicyModule {
  return {
    id: "shellRisk",
    evaluate(request) {
      if (request.actionType !== "shell_exec") {
        return undefined;
      }
      const command =
        (typeof request.context?.command === "string" ? request.context.command : undefined) ??
        (typeof request.payloadSummary === "string" ? request.payloadSummary : "");
      const shell = classifyShellCommand({
        command,
        cwd: typeof request.context?.cwd === "string" ? request.context.cwd : undefined,
        elevated: request.context?.elevated === true,
      });
      if (!shell.riskTags.includes("network_write")) {
        return undefined;
      }
      return policyResult({
        policyId: "shellRisk",
        decision: "requireApproval",
        reasonCode: "shell_risk",
        reason: "External network shell command requires approval",
        correlationId: request.correlationId,
      });
    },
  };
}

function expectedEvidenceFromRequest(request: PolicyRequest): {
  repoRoot: string;
  branch: string;
  commitSha?: string;
  commitRange?: string;
} {
  return {
    repoRoot:
      (typeof request.context?.repoRoot === "string" ? request.context.repoRoot : undefined) ??
      process.cwd(),
    branch:
      (typeof request.context?.branch === "string" ? request.context.branch : undefined) ??
      "agent/forge-mch-61-action-sink-policy-20260426-1940",
    commitSha:
      typeof request.context?.commitSha === "string" ? request.context.commitSha : undefined,
    commitRange:
      typeof request.context?.commitRange === "string" ? request.context.commitRange : undefined,
  };
}

export function createDefaultActionSinkPolicyConfig(): ActionSinkPolicyConfig {
  const fixture = createMissionControlActionSinkPolicyFixture();
  return parseActionSinkPolicyConfig({
    ...fixture,
    defaultMode: "enforce",
    moduleModes: {
      ...fixture.moduleModes,
      protectedWorktree: "enforce",
      externalActionFirewall: "enforce",
      evidenceGate: "enforce",
      shellRisk: "enforce",
    },
  });
}

export function createDefaultActionSinkPolicyModules(
  config: ActionSinkPolicyConfig,
  request: PolicyRequest,
): PolicyModule[] {
  const modules: PolicyModule[] = [
    createProtectedWorktreePolicyModule(config),
    createExternalActionFirewallModule(config),
    createShellRiskPolicyModule(),
  ];
  if (request.actionType === "completion_claim") {
    modules.push(createEvidenceGatePolicyModule(expectedEvidenceFromRequest(request)));
  }
  return modules;
}

function isHighRiskAction(request: PolicyRequest): boolean {
  return [
    "file_write",
    "git_mutation",
    "shell_exec",
    "message_send",
    "external_api_write",
    "status_transition",
    "completion_claim",
  ].includes(request.actionType);
}

function resolveEffectivePolicyEvaluation(
  request: PolicyRequest,
  options: ActionSinkEnforcementOptions,
) {
  const effectiveOptions = testingOverride ? { ...options, ...testingOverride } : options;
  const config = effectiveOptions.config ?? createDefaultActionSinkPolicyConfig();
  const modules = effectiveOptions.modules ?? createDefaultActionSinkPolicyModules(config, request);
  const normalizedRequest: PolicyRequest = {
    ...request,
    payloadSummary: summarizePolicyPayload(request.payloadSummary),
  };
  const result = evaluateActionSinkPolicy(normalizedRequest, config, modules);
  return { effectiveOptions, normalizedRequest, result };
}

export async function evaluateConfiguredActionSinkPolicy(
  request: PolicyRequest,
  options: ActionSinkEnforcementOptions = {},
): Promise<PolicyResult> {
  const { effectiveOptions, normalizedRequest, result } = resolveEffectivePolicyEvaluation(
    request,
    options,
  );
  if (effectiveOptions.auditPath) {
    try {
      await auditPolicyDecision({
        auditPath: effectiveOptions.auditPath,
        request: normalizedRequest,
        result,
        highRisk: isHighRiskAction(normalizedRequest),
      });
    } catch (err) {
      if (isHighRiskAction(normalizedRequest)) {
        return policyResult({
          decision: "block",
          policyId: "action-sink-audit",
          reasonCode: "audit_failed",
          reason: `Action-sink audit append failed: ${String(err)}`,
          correlationId: normalizedRequest.correlationId,
        });
      }
    }
  }
  return result;
}

function throwIfPolicyDenied(result: PolicyResult): void {
  if (result.decision === "block") {
    throw new Error(result.reason);
  }
  if (result.decision === "requireApproval") {
    throw new Error(result.reason);
  }
}

export function evaluateConfiguredActionSinkPolicySync(
  request: PolicyRequest,
  options: ActionSinkEnforcementOptions = {},
): PolicyResult {
  return resolveEffectivePolicyEvaluation(request, options).result;
}

export async function enforceActionSinkPolicy(
  request: PolicyRequest,
  options: ActionSinkEnforcementOptions = {},
): Promise<PolicyResult> {
  const result = await evaluateConfiguredActionSinkPolicy(request, options);
  throwIfPolicyDenied(result);
  return result;
}

export function enforceActionSinkPolicySync(
  request: PolicyRequest,
  options: ActionSinkEnforcementOptions = {},
): PolicyResult {
  const result = evaluateConfiguredActionSinkPolicySync(request, options);
  throwIfPolicyDenied(result);
  return result;
}

export function actionSinkTargetFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path", "cwd", "workdir", "target", "to"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return key === "to" ? value.trim() : path.resolve(value.trim());
    }
  }
  return undefined;
}

export const __testing = {
  setActionSinkEnforcementOverride(override: ActionSinkEnforcementOptions | null) {
    testingOverride = override;
  },
  createShellRiskPolicyModule,
};
