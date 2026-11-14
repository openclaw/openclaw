import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isConfigReadFailure } from "../config/io.invalid-config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";
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

// The config writer stamps this privacy opt-out into every new file, so it proves nothing authored.
function isFirstWritePluginsConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { entries, ...rest } = value;
  return (
    Object.keys(rest).length === 0 &&
    isRecord(entries) &&
    Object.entries(entries).every(([pluginId, entry]) =>
      isNativeSessionCatalogOptOutOnly(pluginId, entry),
    )
  );
}

export function isUnconfiguredConfigSource(sourceConfig: Record<string, unknown>): boolean {
  return Object.entries(sourceConfig).every(
    ([key, value]) =>
      UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key) ||
      (key === "wizard" && isIncompleteWizardConfig(value)) ||
      (key === "plugins" && isFirstWritePluginsConfig(value)),
  );
}

export async function shouldStartLocalOnboarding(
  snapshot: Pick<
    ConfigFileSnapshot,
    "exists" | "valid" | "sourceConfig" | "sourceConfigBeforeMigrations" | "path"
  >,
): Promise<boolean> {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid || snapshot.sourceConfig.gateway?.mode === "remote") {
    return false;
  }
  // Migrations add an implicit agent roster, so only the pre-migration view shows authored setup.
  if (isUnconfiguredConfigSource(snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig)) {
    return true;
  }
  // Inference persists before setup finishes; only its owning receipt can
  // distinguish interrupted local onboarding from an authored model-only config.
  const { readLocalOnboardingStateForConfigAsync } =
    await import("../state/local-onboarding-state.js");
  return (
    (await readLocalOnboardingStateForConfigAsync(snapshot.path, snapshot.sourceConfig))?.status ===
    "pending"
  );
}

export async function resolveBareRootLaunchTarget(
  resolveConfiguredTarget: (
    config: OpenClawConfig,
    options: { hasConfiguredGateway: boolean },
  ) => Promise<BareRootLaunchTarget>,
): Promise<BareRootLaunchTarget> {
  const { readConfigSnapshotForEngineSelection } =
    await import("../commands/config-preflight-snapshot.js");
  const selected = await readConfigSnapshotForEngineSelection();
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot =
    isConfigReadFailure(selected) ||
    selected.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
      ? selected
      : await readConfigFileSnapshot();
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
