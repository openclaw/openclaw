export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";

/** Iframe sandbox policy advertised to the Control UI bootstrap payload. */
export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

/** Runtime config consumed by the browser Control UI before it opens RPC channels. */
export type ControlUiBootstrapConfig = {
  /** Gateway base path used to resolve HTTP assets and WebSocket endpoints. */
  basePath: string;
  /** Display name shown for assistant-authored messages. */
  assistantName: string;
  /** Avatar URL or data URI selected for the assistant. */
  assistantAvatar: string;
  /** Source descriptor used for diagnostics when avatar resolution falls back. */
  assistantAvatarSource?: string | null;
  /** Avatar source class surfaced to the UI for status/debug rendering. */
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  /** Human-readable reason for avatar fallback or rejection. */
  assistantAvatarReason?: string | null;
  /** Agent id the Control UI should target for assistant interactions. */
  assistantAgentId: string;
  /** Optional gateway build/version string displayed by diagnostics surfaces. */
  serverVersion?: string;
  /** Local filesystem roots the browser may request for media previews. */
  localMediaPreviewRoots?: string[];
  /** Sandbox mode applied to embedded tool/plugin iframes. */
  embedSandbox?: ControlUiEmbedSandboxMode;
  /** Allows configured external embed URLs instead of local-only embeds. */
  allowExternalEmbedUrls?: boolean;
  /** CSS width token controlling rendered chat message measure. */
  chatMessageMaxWidth?: string;
};
