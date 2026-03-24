// Default service labels (canonical + legacy compatibility)
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "EVOX.sh Gateway";
export const GATEWAY_SERVICE_MARKER = "evox";
export const GATEWAY_SERVICE_KIND = "gateway";
export const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
export const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
export const NODE_WINDOWS_TASK_NAME = "EVOX.sh Node";
export const NODE_SERVICE_MARKER = "evox";
export const NODE_SERVICE_KIND = "node";
export const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS: string[] = [];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = [
  "clawdbot-gateway",
  "moltbot-gateway",
];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES: string[] = [];

export function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return null;
  }
  return trimmed;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.openclaw.${normalized}`;
}

export function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[] {
  void profile;
  return [];
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) {
    return GATEWAY_SYSTEMD_SERVICE_NAME;
  }
  return `openclaw-gateway${suffix}`;
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_WINDOWS_TASK_NAME;
  }
  return `EVOX.sh Gateway (${normalized})`;
}

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
}): string {
  const profile = normalizeGatewayProfile(params?.profile);
  const version = params?.version?.trim();
  const parts: string[] = [];
  if (profile) {
    parts.push(`profile: ${profile}`);
  }
  if (version) {
    parts.push(`v${version}`);
  }
  if (parts.length === 0) {
    return "EVOX.sh Gateway";
  }
  return `EVOX.sh Gateway (${parts.join(", ")})`;
}

export function resolveGatewayServiceDescription(params: {
  env: Record<string, string | undefined>;
  environment?: Record<string, string | undefined>;
  description?: string;
}): string {
  // Support both EVOX_* (new) and OPENCLAW_* (legacy)
  const profile = params.env.EVOX_PROFILE ?? params.env.OPENCLAW_PROFILE;
  const version =
    params.environment?.EVOX_SERVICE_VERSION ??
    params.environment?.OPENCLAW_SERVICE_VERSION ??
    params.env.EVOX_SERVICE_VERSION ??
    params.env.OPENCLAW_SERVICE_VERSION;
  return params.description ?? formatGatewayServiceDescription({ profile, version });
}

export function resolveNodeLaunchAgentLabel(): string {
  return NODE_LAUNCH_AGENT_LABEL;
}

export function resolveNodeSystemdServiceName(): string {
  return NODE_SYSTEMD_SERVICE_NAME;
}

export function resolveNodeWindowsTaskName(): string {
  return NODE_WINDOWS_TASK_NAME;
}

export function formatNodeServiceDescription(params?: { version?: string }): string {
  const version = params?.version?.trim();
  if (!version) {
    return "EVOX.sh Node Host";
  }
  return `EVOX.sh Node Host (v${version})`;
}
