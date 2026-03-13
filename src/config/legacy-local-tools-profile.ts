import type { OpenClawConfig } from "./config.js";
import type { ToolProfileId } from "./types.tools.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyProfileKey(tools: unknown): boolean {
  if (!isRecord(tools)) {
    return false;
  }
  const keys = Object.keys(tools).filter((key) => !key.startsWith("__"));
  return keys.length === 1 && keys[0] === "profile";
}

/**
 * v2026.3.x local onboarding accidentally persisted `tools.profile="messaging"`
 * for coding-oriented local workspace installs. Preserve intentional messaging
 * profiles, but reinterpret the old pure-onboarding signature as `coding`.
 */
export function resolveLegacyLocalOnboardingToolsProfile(
  config: Pick<OpenClawConfig, "agents" | "gateway" | "tools"> | Record<string, unknown> | null,
  profile?: string,
): ToolProfileId | undefined {
  if (profile !== "messaging" || !isRecord(config)) {
    return profile;
  }

  const gateway = config.gateway;
  if (!isRecord(gateway) || gateway.mode !== "local") {
    return profile;
  }

  const agents = config.agents;
  const defaults = isRecord(agents) ? agents.defaults : undefined;
  const workspace =
    isRecord(defaults) && typeof defaults.workspace === "string" ? defaults.workspace.trim() : "";
  if (!workspace) {
    return profile;
  }

  if (!hasOnlyProfileKey(config.tools)) {
    return profile;
  }

  return "coding";
}
