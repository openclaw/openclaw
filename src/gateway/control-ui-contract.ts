// Control UI bootstrap contract served by the gateway and consumed by the
// browser app before it knows runtime branding, media roots, or embed policy.
/** HTTP path for the Control UI bootstrap config payload (base-path-relative). */
export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/control-ui-config.json";

/**
 * Legacy documented path preserved for backward compatibility with existing
 * docs, reverse-proxy rules, and custom clients that reference the old
 * namespace-prefixed endpoint. Only matched on root-mounted gateways (no
 * basePath); basePath-prefixed gateways exclusively use the new relative path.
 * @deprecated Use {@link CONTROL_UI_BOOTSTRAP_CONFIG_PATH} instead.
 */
export const LEGACY_CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";

/** Sandbox policy for assistant-provided embed surfaces inside Control UI. */
export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

/** Runtime config consumed by the browser Control UI during bootstrap. */
export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string;
  serverVersion?: string;
  localMediaPreviewRoots?: string[];
  embedSandbox?: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string;
};
