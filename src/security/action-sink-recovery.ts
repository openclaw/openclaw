import fs from "node:fs/promises";
import path from "node:path";
import type { ActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import type { PolicyMode } from "./action-sink-policy.js";

export type RecoveryRequest = {
  actorId: string;
  reason: string;
  emergencyLogPath?: string;
};

function assertOperator(config: ActionSinkPolicyConfig, actorId: string): void {
  if (!config.recovery.operatorIds.includes(actorId)) {
    throw new Error("Only configured operators may change action-sink recovery mode");
  }
}

async function logRecovery(filePath: string | undefined, message: string): Promise<void> {
  if (!filePath) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(
    filePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), message })}\n`,
  );
}

export async function setActionSinkGlobalMode(
  config: ActionSinkPolicyConfig,
  mode: PolicyMode,
  request: RecoveryRequest,
): Promise<ActionSinkPolicyConfig> {
  assertOperator(config, request.actorId);
  const next = { ...config, defaultMode: mode };
  await logRecovery(
    request.emergencyLogPath ?? config.recovery.emergencyLogPath,
    `global mode set to ${mode}: ${request.reason}`,
  );
  return next;
}

export async function disableActionSinkModule(
  config: ActionSinkPolicyConfig,
  moduleId: string,
  request: RecoveryRequest,
): Promise<ActionSinkPolicyConfig> {
  assertOperator(config, request.actorId);
  const next = {
    ...config,
    moduleModes: { ...config.moduleModes, [moduleId]: "disabled" as const },
  };
  await logRecovery(
    request.emergencyLogPath ?? config.recovery.emergencyLogPath,
    `module ${moduleId} disabled: ${request.reason}`,
  );
  return next;
}
