import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Default service labels (canonical + legacy compatibility)
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
const GATEWAY_WINDOWS_TASK_NAME = "OpenClaw Gateway";
export const GATEWAY_SERVICE_MARKER = "openclaw";
export const GATEWAY_SERVICE_KIND = "gateway";
export const GATEWAY_SERVICE_RUNTIME_PID_ENV = "OPENCLAW_GATEWAY_SERVICE_PID";
export const GATEWAY_SERVICE_SELECTOR_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const;

export function isGatewayServiceEnv(env: Record<string, string | undefined>): boolean {
  if (env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
const NODE_WINDOWS_TASK_NAME = "OpenClaw Node";
const NODE_SERVICE_MARKER = "openclaw";
export const NODE_SERVICE_KIND = "node";
const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = ["clawdbot-gateway"];

function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  // The default profile keeps the historical unqualified service names.
  return trimmed && normalizeLowercaseStringOrEmpty(trimmed) !== "default" ? trimmed : null;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `ai.openclaw.${normalized}` : GATEWAY_LAUNCH_AGENT_LABEL;
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  return `${GATEWAY_SYSTEMD_SERVICE_NAME}${resolveGatewayProfileSuffix(profile)}`;
}

/**
 * Service-name candidates for a profile, preferred order.
 *
 * Current installs use `openclaw-gateway[-profile]`. Older multi-agent hosts
 * used `openclaw-<profile>` (no "gateway" segment). Doctor/runtime resolution
 * must try both for the same profile before scanning unrelated units.
 */
export function resolveGatewaySystemdServiceNameCandidates(profile?: string): string[] {
  const canonical = resolveGatewaySystemdServiceName(profile);
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) {
    // Default profile: openclaw-gateway is current; bare openclaw is a known
    // legacy system-unit name (parallel to openclaw-<profile> for named agents).
    // Custom names are matched separately against their effective installation identity.
    return [canonical, "openclaw"];
  }
  const legacy = `openclaw${suffix}`;
  // Never adopt the default node or another profile's canonical Gateway.
  return legacy === NODE_SYSTEMD_SERVICE_NAME ||
    legacy === GATEWAY_SYSTEMD_SERVICE_NAME ||
    legacy.startsWith(`${GATEWAY_SYSTEMD_SERVICE_NAME}-`)
    ? [canonical]
    : [canonical, legacy];
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `${GATEWAY_WINDOWS_TASK_NAME} (${normalized})` : GATEWAY_WINDOWS_TASK_NAME;
}

export function normalizeWindowsTaskIdentity(value: string): string {
  // Root prefixes and casing do not change task identity; nested folders do.
  return value.replace(/^\\+/, "").toLowerCase();
}

type GatewayNativeServiceIdentityConflict = {
  envKey: "OPENCLAW_LAUNCHD_LABEL" | "OPENCLAW_SYSTEMD_UNIT" | "OPENCLAW_WINDOWS_TASK_NAME";
  expected: string;
};

export function resolveGatewayNativeServiceIdentityConflict(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): GatewayNativeServiceIdentityConflict | null {
  const profile = normalizeGatewayProfile(env.OPENCLAW_PROFILE);
  if (!profile) {
    return null;
  }

  if (platform === "darwin") {
    const envKey = "OPENCLAW_LAUNCHD_LABEL";
    const actual = env[envKey]?.trim();
    const expected = resolveGatewayLaunchAgentLabel(profile);
    return actual && actual !== expected ? { envKey, expected } : null;
  }
  if (platform === "linux") {
    const envKey = "OPENCLAW_SYSTEMD_UNIT";
    const actual = env[envKey]?.trim();
    const normalizedActual = actual?.endsWith(".service") ? actual : actual && `${actual}.service`;
    const expected = `${resolveGatewaySystemdServiceName(profile)}.service`;
    return normalizedActual && normalizedActual !== expected ? { envKey, expected } : null;
  }
  if (platform === "win32") {
    const envKey = "OPENCLAW_WINDOWS_TASK_NAME";
    const actual = env[envKey]?.trim();
    const expected = resolveGatewayWindowsTaskName(profile);
    return actual && normalizeWindowsTaskIdentity(actual) !== normalizeWindowsTaskIdentity(expected)
      ? { envKey, expected }
      : null;
  }
  return null;
}

function formatGatewayServiceDescription(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `OpenClaw Gateway (profile: ${normalized})` : "OpenClaw Gateway";
}

export function resolveGatewayServiceDescription(params: {
  env: Record<string, string | undefined>;
  description?: string;
}): string {
  return params.description ?? formatGatewayServiceDescription(params.env.OPENCLAW_PROFILE);
}

export function resolveNodeLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `${NODE_LAUNCH_AGENT_LABEL}.${normalized}` : NODE_LAUNCH_AGENT_LABEL;
}

export function isNodeLaunchAgentLabel(label: string): boolean {
  return label === NODE_LAUNCH_AGENT_LABEL || label.startsWith(`${NODE_LAUNCH_AGENT_LABEL}.`);
}

export function resolveNodeSystemdServiceName(profile?: string): string {
  return `${NODE_SYSTEMD_SERVICE_NAME}${resolveGatewayProfileSuffix(profile)}`;
}

export function resolveNodeWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `${NODE_WINDOWS_TASK_NAME} (${normalized})` : NODE_WINDOWS_TASK_NAME;
}

export function resolveNodeServiceIdentityEnvironment(
  env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const profile = env.OPENCLAW_PROFILE;
  return {
    OPENCLAW_PROFILE: profile,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(profile),
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(profile),
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(profile),
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    // launchd writes every node's supervisor logs to one ~/Library/Logs/openclaw.
    OPENCLAW_LOG_PREFIX: `node${resolveGatewayProfileSuffix(profile)}`,
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}
