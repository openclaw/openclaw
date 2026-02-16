export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";

export type ControlUiProfile = "openclaw" | "americanclaw" | "elsehelp";

export const DEFAULT_CONTROL_UI_PROFILE: ControlUiProfile = "americanclaw";

export function isControlUiProfile(value: unknown): value is ControlUiProfile {
  return value === "openclaw" || value === "americanclaw" || value === "elsehelp";
}

export type ControlUiBootstrapConfig = {
  basePath: string;
  profile: ControlUiProfile;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
};
