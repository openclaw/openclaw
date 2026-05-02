import path from "node:path";
import { auditPolicyDecision } from "./action-sink-audit.js";
import type { ActionSinkPolicyConfig, ExternalAllowlistRule } from "./action-sink-policy-config.js";
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
      if (
        typeof request.context?.actionSinkApproval === "object" &&
        request.context.actionSinkApproval !== null &&
        (request.context.actionSinkApproval as Record<string, unknown>).source ===
          "exec-approval" &&
        typeof (request.context.actionSinkApproval as Record<string, unknown>).approvalId ===
          "string"
      ) {
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

function parseExternalAllowlistEnv(value = process.env.OPENCLAW_ACTION_SINK_EXTERNAL_ALLOWLIST) {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((entry): ExternalAllowlistRule | null => {
      const [targetPattern, actionTypes] = entry.split("|", 2);
      const target = targetPattern?.trim();
      if (!target) {
        return null;
      }
      const parsedActionTypes = actionTypes
        ?.split("+")
        .map((item) => item.trim())
        .filter(Boolean) as ExternalAllowlistRule["actionTypes"];
      return {
        targetPattern: target,
        ...(parsedActionTypes?.length ? { actionTypes: parsedActionTypes } : {}),
      };
    })
    .filter((rule): rule is ExternalAllowlistRule => rule != null);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function isApprovedExecCompletionFollowup(request: PolicyRequest): boolean {
  if (request.actionType !== "completion_claim" || request.toolName !== "outbound.deliver") {
    return false;
  }
  const context = request.context;
  if (!isPlainRecord(context)) {
    return false;
  }
  const marker = context.actionSinkContext;
  if (!isPlainRecord(marker) || marker.source !== "approved_exec_completion") {
    return false;
  }

  const approvalId = nonEmptyString(marker.approvalId);
  const idempotencyKey = nonEmptyString(marker.idempotencyKey);
  const sessionKey = nonEmptyString(marker.sessionKey);
  const channel = nonEmptyString(marker.channel);
  const to = nonEmptyString(marker.to);
  if (!approvalId || !idempotencyKey || !sessionKey || !channel || !to) {
    return false;
  }
  if (idempotencyKey !== `exec-approval-followup:${approvalId}`) {
    return false;
  }
  if (sessionKey !== nonEmptyString(context.sessionKey)) {
    return false;
  }
  if (request.actor?.sessionKey !== sessionKey) {
    return false;
  }
  if (channel !== nonEmptyString(context.channel) || to !== nonEmptyString(context.to)) {
    return false;
  }
  if (request.targetResource !== `${channel}:${to}`) {
    return false;
  }

  const contextAccountId = nonEmptyString(context.accountId);
  const markerAccountId = nonEmptyString(marker.accountId);
  if (contextAccountId && markerAccountId !== contextAccountId) {
    return false;
  }
  const contextThreadId = optionalString(context.threadId);
  const markerThreadId = optionalString(marker.threadId);
  if (contextThreadId && markerThreadId !== contextThreadId) {
    return false;
  }
  return true;
}

function taskRegistryDeliveryIdempotencyMatches(params: {
  delivery: string;
  idempotencyKey: string;
  taskId: string;
}): boolean {
  const parts = params.idempotencyKey.split(":");
  if (params.delivery === "terminal") {
    return (
      (parts[0] === "task-terminal" && parts[1] === params.taskId && parts.length >= 4) ||
      (parts[0] === "flow-terminal" && parts[2] === params.taskId && parts.length >= 5)
    );
  }
  if (params.delivery === "state_change") {
    return (
      (parts[0] === "task-event" && parts[1] === params.taskId && parts.length >= 4) ||
      (parts[0] === "flow-event" && parts[2] === params.taskId && parts.length >= 5)
    );
  }
  return false;
}

function isTaskRegistryDeliveryFollowup(request: PolicyRequest): boolean {
  if (request.actionType !== "completion_claim" || request.toolName !== "outbound.deliver") {
    return false;
  }
  const context = request.context;
  if (!isPlainRecord(context)) {
    return false;
  }
  const marker = context.actionSinkContext;
  if (!isPlainRecord(marker) || marker.source !== "task_registry_delivery") {
    return false;
  }

  const taskId = nonEmptyString(marker.taskId);
  const idempotencyKey = nonEmptyString(marker.idempotencyKey);
  const sessionKey = nonEmptyString(marker.sessionKey);
  const channel = nonEmptyString(marker.channel);
  const to = nonEmptyString(marker.to);
  const delivery = nonEmptyString(marker.delivery);
  if (!taskId || !idempotencyKey || !sessionKey || !channel || !to || !delivery) {
    return false;
  }
  if (!taskRegistryDeliveryIdempotencyMatches({ taskId, idempotencyKey, delivery })) {
    return false;
  }
  if (sessionKey !== nonEmptyString(context.sessionKey)) {
    return false;
  }
  if (request.actor?.sessionKey !== sessionKey) {
    return false;
  }
  if (channel !== nonEmptyString(context.channel) || to !== nonEmptyString(context.to)) {
    return false;
  }
  if (request.targetResource !== `${channel}:${to}`) {
    return false;
  }

  const contextAccountId = nonEmptyString(context.accountId);
  const markerAccountId = nonEmptyString(marker.accountId);
  if (contextAccountId && markerAccountId !== contextAccountId) {
    return false;
  }
  const contextThreadId = optionalString(context.threadId);
  const markerThreadId = optionalString(marker.threadId);
  if (contextThreadId && markerThreadId !== contextThreadId) {
    return false;
  }
  return true;
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
    externalAllowlist: [...fixture.externalAllowlist, ...parseExternalAllowlistEnv()],
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
  if (
    request.actionType === "completion_claim" &&
    !isApprovedExecCompletionFollowup(request) &&
    !isTaskRegistryDeliveryFollowup(request)
  ) {
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

export class ActionSinkPolicyDeniedError extends Error {
  readonly name = "ActionSinkPolicyDeniedError";
  readonly decision: PolicyResult["decision"];
  readonly policyId: string;
  readonly reasonCode: PolicyResult["reasonCode"];

  constructor(result: PolicyResult) {
    super(result.reason);
    this.decision = result.decision;
    this.policyId = result.policyId;
    this.reasonCode = result.reasonCode;
  }
}

export function isActionSinkPolicyDeniedError(
  error: unknown,
): error is ActionSinkPolicyDeniedError {
  return error instanceof ActionSinkPolicyDeniedError;
}

function throwIfPolicyDenied(result: PolicyResult): void {
  if (result.decision === "block") {
    throw new ActionSinkPolicyDeniedError(result);
  }
  if (result.decision === "requireApproval") {
    throw new ActionSinkPolicyDeniedError(result);
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
