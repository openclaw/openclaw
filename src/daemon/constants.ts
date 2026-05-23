import { isClaworksProduct } from "../config/paths.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

// Default service labels (canonical + legacy compatibility)
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
/** ClaWorks product launchd label (macOS) */
export const CLAWORKS_GATEWAY_LAUNCH_AGENT_LABEL = "ai.claworks.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
export const CLAWORKS_GATEWAY_SYSTEMD_SERVICE_NAME = "claworks-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "OpenClaw Gateway";
export const CLAWORKS_GATEWAY_WINDOWS_TASK_NAME = "ClaWorks Gateway";
export const GATEWAY_SERVICE_MARKER = "openclaw";
export const CLAWORKS_GATEWAY_SERVICE_MARKER = "claworks";
export const GATEWAY_SERVICE_KIND = "gateway";
const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
const NODE_WINDOWS_TASK_NAME = "OpenClaw Node";
export const NODE_SERVICE_MARKER = "openclaw";
export const NODE_SERVICE_KIND = "node";
export const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = ["clawdbot-gateway"];

export function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || normalizeLowercaseStringOrEmpty(trimmed) === "default") {
    return null;
  }
  return trimmed;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayServiceMarker(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksProduct(env) ? CLAWORKS_GATEWAY_SERVICE_MARKER : GATEWAY_SERVICE_MARKER;
}

export function resolveGatewayLaunchAgentLabel(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeGatewayProfile(profile);
  if (isClaworksProduct(env)) {
    if (!normalized) {
      return CLAWORKS_GATEWAY_LAUNCH_AGENT_LABEL;
    }
    return `ai.claworks.${normalized}`;
  }
  if (!normalized) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.openclaw.${normalized}`;
}

export function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[] {
  void profile;
  return [];
}

export function resolveGatewaySystemdServiceName(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  const base = isClaworksProduct(env)
    ? CLAWORKS_GATEWAY_SYSTEMD_SERVICE_NAME
    : GATEWAY_SYSTEMD_SERVICE_NAME;
  if (!suffix) {
    return base;
  }
  return `${base}${suffix}`;
}

export function resolveGatewayWindowsTaskName(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeGatewayProfile(profile);
  const base = isClaworksProduct(env)
    ? CLAWORKS_GATEWAY_WINDOWS_TASK_NAME
    : GATEWAY_WINDOWS_TASK_NAME;
  if (!normalized) {
    return base;
  }
  return `${base} (${normalized})`;
}

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params?.env ?? process.env;
  const brand = isClaworksProduct(env) ? "ClaWorks" : "OpenClaw";
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
    return `${brand} Gateway`;
  }
  return `${brand} Gateway (${parts.join(", ")})`;
}

export function resolveGatewayServiceDescription(params: {
  env: Record<string, string | undefined>;
  environment?: Record<string, string | undefined>;
  description?: string;
}): string {
  return (
    params.description ??
    formatGatewayServiceDescription({
      profile: params.env.OPENCLAW_PROFILE,
      version: params.environment?.OPENCLAW_SERVICE_VERSION ?? params.env.OPENCLAW_SERVICE_VERSION,
      env: params.env as NodeJS.ProcessEnv,
    })
  );
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
    return "OpenClaw Node Host";
  }
  return `OpenClaw Node Host (v${version})`;
}
