export const GATEWAY_NODE_PLATFORM_ALLOWLIST_VALUES = [
  "ios",
  "ipados",
  "android",
  "macos",
  "windows",
  "linux",
] as const;

export type GatewayNodePlatformAllowlistValue =
  (typeof GATEWAY_NODE_PLATFORM_ALLOWLIST_VALUES)[number];
