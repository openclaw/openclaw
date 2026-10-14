import { addServiceEnvPlanEntries, type MutableServiceEnvPlan } from "./service-env-plan.js";
import {
  readManagedServiceEnvKeysFromEnvironment,
  writeManagedServiceEnvKeysToEnvironment,
} from "./service-managed-env.js";

export function applyManagedServiceEnvRenderPolicy(params: {
  plan: MutableServiceEnvPlan;
  managedServiceEnvKeys: string | undefined;
  serviceEnvironment: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  existingSecretRefEnvironment: Record<string, string | undefined>;
  stateDirDotEnvEnvironment: Record<string, string | undefined>;
  configSecretRefEnvironment: Record<string, string | undefined>;
}): void {
  const launchAgent =
    params.platform === "darwin" &&
    Boolean(params.serviceEnvironment.OPENCLAW_LAUNCHD_LABEL?.trim());
  writeManagedServiceEnvKeysToEnvironment(params.plan.environment, params.managedServiceEnvKeys);
  if (params.plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS) {
    params.plan.environmentValueSources.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "inline";
  }
  const managedKeys = readManagedServiceEnvKeysFromEnvironment({
    OPENCLAW_SERVICE_MANAGED_ENV_KEYS: params.managedServiceEnvKeys,
  });
  if (managedKeys.size === 0) {
    return;
  }
  // Preserve installed values for active SecretRefs, migrating legacy inline values
  // into the supervisor's owner-only env file before the service is rewritten.
  if (launchAgent || params.platform === "linux") {
    addServiceEnvPlanEntries(params.plan, params.existingSecretRefEnvironment, {
      includeKeys: managedKeys,
      valueSource: "file",
    });
  }
  if (launchAgent) {
    addServiceEnvPlanEntries(params.plan, params.stateDirDotEnvEnvironment, {
      includeKeys: managedKeys,
      valueSource: "inline",
    });
  }
  addServiceEnvPlanEntries(params.plan, params.configSecretRefEnvironment, {
    includeKeys: managedKeys,
    valueSource: params.platform === "linux" ? "file" : "inline",
  });
}
