export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";
export const CONTROL_UI_ME_CONTEXT_PATH = "/api/me/context";

export const CONTROL_UI_OPERATOR_ROLE = "operator";
export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
};

export type RoleId = "user" | "admin" | "main_operator";
export type ScopeType = "private" | "group" | "global";
export type PrivacyMode = "private" | "group_shared" | "global_shared" | "admin";
export type SessionType = "private_chat" | "group_chat" | "global_chat" | "operator_chat";
export type LaunchableSessionType = SessionType;

export type OperatorAuthContext = {
  role: string;
  scopes: string[];
  deviceTokenIssuedAtMs: number | null;
};

export type ScopeRef = {
  type: ScopeType;
  id: string;
  label: string;
  privacyMode: PrivacyMode;
};

export type RuntimeUser = {
  id: string;
  displayName: string;
  role: RoleId;
  roleLabel: string;
  groups: string[];
};

export type ControlUiMeContextResponse = {
  user: RuntimeUser;
  groups: string[];
  visibleScopes: ScopeRef[];
  launchableSessionTypes: LaunchableSessionType[];
  currentSessionType: SessionType;
  shareTargets: ScopeRef[];
  selectedScope: ScopeRef | null;
  selectedPrivacyMode: PrivacyMode;
  operator: OperatorAuthContext;
};
