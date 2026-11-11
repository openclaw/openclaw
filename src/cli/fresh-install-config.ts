import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";

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
