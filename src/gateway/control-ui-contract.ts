export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__bot/control-ui-config.json";

export type ControlUiBootstrapIamConfig = {
  serverUrl: string;
  clientId: string;
  appName?: string;
  orgName?: string;
  scopes?: string[];
};

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
  authMode?: "token" | "password" | "trusted-proxy" | "iam" | "none";
  iam?: ControlUiBootstrapIamConfig;
  /** Pre-authenticated token forwarded from HTTP Bearer auth. */
  token?: string;
  /** Billing top-up URL. */
  billingUrl?: string;
  /** Whether the P2P marketplace is enabled on this gateway. */
  marketplaceEnabled?: boolean;
};
