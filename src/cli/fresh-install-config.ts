import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { BareRootLaunchTarget } from "./run-main.gateway-types.js";

const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);

function isIncompleteWizardConfig(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "securityAcknowledgedAt" || key === "accessMode")
  );
}

export function isUnconfiguredConfigSource(sourceConfig: Record<string, unknown>): boolean {
  return Object.entries(sourceConfig).every(
    ([key, value]) =>
      UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key) ||
      (key === "wizard" && isIncompleteWizardConfig(value)),
  );
}

export async function shouldStartLocalOnboarding(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig" | "path">,
): Promise<boolean> {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid || snapshot.sourceConfig.gateway?.mode === "remote") {
    return false;
  }
  if (isUnconfiguredConfigSource(snapshot.sourceConfig)) {
    return true;
  }
  // Inference persists before setup finishes; only its owning receipt can
  // distinguish interrupted local onboarding from an authored model-only config.
  const { readLocalOnboardingStateForConfig } = await import("../state/local-onboarding-state.js");
  return (
    readLocalOnboardingStateForConfig(snapshot.path, snapshot.sourceConfig)?.status === "pending"
  );
}

export async function resolveBareRootLaunchTarget(
  resolveConfiguredTarget: (
    config: OpenClawConfig,
    options: { hasConfiguredGateway: boolean },
  ) => Promise<BareRootLaunchTarget>,
): Promise<BareRootLaunchTarget> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const { formatConfigReadFailureForCli } = await import("./config-validation-output.js");
    const diagnostic = formatConfigReadFailureForCli(snapshot);
    if (diagnostic) {
      return { kind: "config-read-failure", diagnostic };
    }
  }
  if (await shouldStartLocalOnboarding(snapshot)) {
    return { kind: "onboarding" };
  }
  if (!snapshot.valid) {
    return { kind: "onboarding", classic: true };
  }
  return resolveConfiguredTarget(snapshot.config ?? snapshot.sourceConfig, {
    hasConfiguredGateway: snapshot.sourceConfig.gateway !== undefined,
  });
}
