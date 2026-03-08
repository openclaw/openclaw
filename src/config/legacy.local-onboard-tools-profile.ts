import { compareOpenClawVersions } from "./version.js";

const LEGACY_LOCAL_ONBOARD_MESSAGING_MAX_VERSION = "2026.3.2";

export const LEGACY_LOCAL_ONBOARD_MESSAGING_MIGRATION_MARKER_COMMAND =
  "onboard-migrated-tools-profile-default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveLegacyLocalOnboardMessagingProfileVersion(
  raw: Record<string, unknown>,
): string | null {
  const tools = isRecord(raw.tools) ? raw.tools : null;
  if (!tools || tools.profile !== "messaging") {
    return null;
  }
  // Preserve explicit custom messaging setups; only migrate the exact generated
  // legacy shape from local onboarding defaults.
  if (Object.keys(tools).some((key) => key !== "profile")) {
    return null;
  }
  const wizard = isRecord(raw.wizard) ? raw.wizard : null;
  if (!wizard) {
    return null;
  }
  const lastRunCommand =
    typeof wizard.lastRunCommand === "string" ? wizard.lastRunCommand.trim() : "";
  if (lastRunCommand !== "onboard") {
    return null;
  }
  const lastRunMode = typeof wizard.lastRunMode === "string" ? wizard.lastRunMode.trim() : "";
  if (lastRunMode !== "local") {
    return null;
  }
  const lastRunVersion =
    typeof wizard.lastRunVersion === "string" ? wizard.lastRunVersion.trim() : "";
  if (!lastRunVersion) {
    return null;
  }
  const compared = compareOpenClawVersions(
    lastRunVersion,
    LEGACY_LOCAL_ONBOARD_MESSAGING_MAX_VERSION,
  );
  if (compared === null || compared > 0) {
    return null;
  }
  return lastRunVersion;
}

export function isLegacyLocalOnboardMessagingToolsProfile(
  value: unknown,
  root: Record<string, unknown>,
): boolean {
  return value === "messaging" && resolveLegacyLocalOnboardMessagingProfileVersion(root) !== null;
}

export function markLegacyLocalOnboardMessagingProfileMigrated(raw: Record<string, unknown>) {
  const wizard = isRecord(raw.wizard) ? raw.wizard : null;
  if (!wizard) {
    return;
  }
  // Mark this one-time migration so future explicit messaging opt-ins are kept.
  wizard.lastRunCommand = LEGACY_LOCAL_ONBOARD_MESSAGING_MIGRATION_MARKER_COMMAND;
}
