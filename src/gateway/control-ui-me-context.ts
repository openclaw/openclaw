import type { IncomingMessage } from "node:http";
import {
  CONTROL_UI_OPERATOR_ROLE,
  CONTROL_UI_OPERATOR_SCOPES,
  type ControlUiMeContextResponse,
  type LaunchableSessionType,
  type PrivacyMode,
  type RuntimeUser,
  type ScopeRef,
  type SessionType,
} from "./control-ui-contract.js";
import { getHeader } from "./http-utils.js";

function titleCaseWords(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeUserIdFromHeaders(req: IncomingMessage): string {
  const deviceId = getHeader(req, "x-openclaw-device-id")?.trim();
  if (deviceId) {
    return deviceId.toLowerCase();
  }
  return "control-ui-operator";
}

function deriveDisplayName(userId: string): string {
  return titleCaseWords(userId.replace(/[._:-]+/g, " "));
}

function deriveRoleFromOperatorScopes(scopes: string[]): RuntimeUser["role"] {
  if (scopes.includes("operator.admin")) {
    return "main_operator";
  }
  if (scopes.includes("operator.write") || scopes.includes("operator.approvals")) {
    return "admin";
  }
  return "user";
}

function deriveRoleLabel(role: RuntimeUser["role"]): string {
  switch (role) {
    case "main_operator":
      return "Main operator";
    case "admin":
      return "Admin";
    default:
      return "User";
  }
}

function deriveGroupsFromHeaders(req: IncomingMessage): string[] {
  const raw = getHeader(req, "x-openclaw-groups")?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((groupId) => groupId.trim())
    .filter((groupId) => groupId.length > 0);
}

function buildPrivateScope(user: RuntimeUser): ScopeRef {
  return {
    type: "private",
    id: `private:${user.id}`,
    label: `${user.displayName} private`,
    privacyMode: "private",
  };
}

function buildGroupScope(groupId: string): ScopeRef {
  return {
    type: "group",
    id: `group:${groupId.toLowerCase()}`,
    label: groupId,
    privacyMode: "group_shared",
  };
}

function buildGlobalScope(): ScopeRef {
  return {
    type: "global",
    id: "global:shared",
    label: "Global",
    privacyMode: "global_shared",
  };
}

function deriveVisibleScopes(user: RuntimeUser): ScopeRef[] {
  const scopes: ScopeRef[] = [buildPrivateScope(user)];
  for (const groupId of user.groups) {
    scopes.push(buildGroupScope(groupId));
  }
  if (user.role === "admin" || user.role === "main_operator") {
    scopes.push(buildGlobalScope());
  }
  return scopes;
}

function deriveLaunchableSessionTypes(user: RuntimeUser): LaunchableSessionType[] {
  const types: LaunchableSessionType[] = ["private_chat"];
  if (user.groups.length > 0) {
    types.push("group_chat");
  }
  if (user.role === "admin" || user.role === "main_operator") {
    types.push("global_chat");
  }
  if (user.role === "main_operator") {
    types.push("operator_chat");
  }
  return types;
}

function deriveCurrentSessionType(user: RuntimeUser): SessionType {
  if (user.role === "main_operator") {
    return "operator_chat";
  }
  if (user.role === "admin") {
    return "global_chat";
  }
  if (user.groups.length > 0) {
    return "group_chat";
  }
  return "private_chat";
}

function deriveShareTargets(user: RuntimeUser): ScopeRef[] {
  const targets: ScopeRef[] = [];
  for (const groupId of user.groups) {
    targets.push(buildGroupScope(groupId));
  }
  if (user.role === "admin" || user.role === "main_operator") {
    targets.push(buildGlobalScope());
  }
  return targets;
}

function deriveSelectedScope(
  visibleScopes: ScopeRef[],
  currentSessionType: SessionType,
): ScopeRef | null {
  if (currentSessionType === "global_chat") {
    return visibleScopes.find((scope) => scope.type === "global") ?? visibleScopes[0] ?? null;
  }
  if (currentSessionType === "group_chat") {
    return visibleScopes.find((scope) => scope.type === "group") ?? visibleScopes[0] ?? null;
  }
  return visibleScopes[0] ?? null;
}

function parseOperatorScopes(req: IncomingMessage): string[] {
  const raw = getHeader(req, "x-openclaw-scopes")?.trim();
  if (!raw) {
    return [...CONTROL_UI_OPERATOR_SCOPES];
  }
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function parseIssuedAt(req: IncomingMessage): number | null {
  const raw = getHeader(req, "x-openclaw-auth-issued-at")?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildControlUiMeContextResponse(req: IncomingMessage): ControlUiMeContextResponse {
  const scopes = parseOperatorScopes(req);
  const userId = normalizeUserIdFromHeaders(req);
  const groups = deriveGroupsFromHeaders(req);
  const role = deriveRoleFromOperatorScopes(scopes);
  const user: RuntimeUser = {
    id: userId,
    displayName: deriveDisplayName(userId),
    role,
    roleLabel: deriveRoleLabel(role),
    groups,
  };

  const visibleScopes = deriveVisibleScopes(user);
  const currentSessionType = deriveCurrentSessionType(user);
  const selectedScope = deriveSelectedScope(visibleScopes, currentSessionType);
  const selectedPrivacyMode: PrivacyMode = selectedScope?.privacyMode ?? "private";

  return {
    user,
    groups: [...user.groups],
    visibleScopes,
    launchableSessionTypes: deriveLaunchableSessionTypes(user),
    currentSessionType,
    shareTargets: deriveShareTargets(user),
    selectedScope,
    selectedPrivacyMode,
    operator: {
      role: getHeader(req, "x-openclaw-role")?.trim() || CONTROL_UI_OPERATOR_ROLE,
      scopes,
      deviceTokenIssuedAtMs: parseIssuedAt(req),
    },
  };
}
