export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";

export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

export type ControlUiBuildProvenance = {
  sourceRepositoryUrl: string | null;
  commitSha: string | null;
  buildTimestamp: string | null;
  packageVersion: string | null;
  lockfileSha256: string | null;
  ciRunId: string | null;
};

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
  buildProvenance?: ControlUiBuildProvenance;
};
