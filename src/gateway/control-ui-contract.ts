// Control UI bootstrap contract served by the gateway and consumed by the
// browser app before it knows runtime branding, media roots, or embed policy.
/** HTTP path for the Control UI bootstrap config payload. */
export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/control-ui-config.json";

/** Carries the gateway-configured Control UI mount path into browser bootstrap. */
export const CONTROL_UI_BASE_PATH_ATTRIBUTE = "data-openclaw-control-ui-base-path";

/** Marks whether the served document CSP permits the terminal WASM runtime. */
export const CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE = "data-openclaw-terminal-enabled";

/** Sandbox policy for assistant-provided embed surfaces inside Control UI. */
export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

/** Public GitHub metadata rendered by Control UI link hover cards. */
export type ControlUiGitHubPreview = {
  additions?: number;
  avatarDataUrl?: string;
  changedFiles?: number;
  closedAt?: string;
  comments?: number;
  createdAt: string;
  deletions?: number;
  draft?: boolean;
  kind: "issue" | "pull";
  login: string;
  mergedAt?: string;
  number: number;
  owner: string;
  repo: string;
  state: string;
  stateReason?: string;
  title: string;
  updatedAt: string;
};

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
  seamColor?: string;
  /** Resolved `agents.defaults.timeFormat`; "auto" keeps the browser locale default. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Whether the operator terminal surface is enabled (`gateway.terminal.enabled`).
   * The Control UI hides the terminal entirely when false so a disabled kill
   * switch removes the surface rather than showing a button that errors on open.
   */
  terminalEnabled?: boolean;
};
