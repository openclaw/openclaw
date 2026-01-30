export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;

// Legacy client IDs for backward compatibility
// These are deprecated but still accepted to prevent breakage during upgrades
export const LEGACY_GATEWAY_CLIENT_IDS = {
  // Clawdbot era (pre-2026.1.29)
  CLAWDBOT_CONTROL_UI: "clawdbot-control-ui",
  CLAWDBOT_MACOS_APP: "clawdbot-macos",
  CLAWDBOT_IOS_APP: "clawdbot-ios",
  CLAWDBOT_ANDROID_APP: "clawdbot-android",
  CLAWDBOT_PROBE: "clawdbot-probe",
  // Moltbot era (intermediate rebrand)
  MOLTBOT_CONTROL_UI: "moltbot-control-ui",
  MOLTBOT_MACOS_APP: "moltbot-macos",
  MOLTBOT_IOS_APP: "moltbot-ios",
  MOLTBOT_ANDROID_APP: "moltbot-android",
  MOLTBOT_PROBE: "moltbot-probe",
} as const;

export const ALL_GATEWAY_CLIENT_IDS = {
  ...GATEWAY_CLIENT_IDS,
  ...LEGACY_GATEWAY_CLIENT_IDS,
} as const;

export type GatewayClientId =
  | (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS]
  | (typeof LEGACY_GATEWAY_CLIENT_IDS)[keyof typeof LEGACY_GATEWAY_CLIENT_IDS];

// Back-compat naming (internal): these values are IDs, not display names.
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
export type GatewayClientName = GatewayClientId;

export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

export type GatewayClientInfo = {
  id: GatewayClientId;
  displayName?: string;
  version: string;
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

const GATEWAY_CLIENT_ID_SET = new Set<GatewayClientId>(
  Object.values(ALL_GATEWAY_CLIENT_IDS),
);
const GATEWAY_CLIENT_MODE_SET = new Set<GatewayClientMode>(Object.values(GATEWAY_CLIENT_MODES));

export function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_ID_SET.has(normalized as GatewayClientId)
    ? (normalized as GatewayClientId)
    : undefined;
}

export function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined {
  return normalizeGatewayClientId(raw);
}

export function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_MODE_SET.has(normalized as GatewayClientMode)
    ? (normalized as GatewayClientMode)
    : undefined;
}
