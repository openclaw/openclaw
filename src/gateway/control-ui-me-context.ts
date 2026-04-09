import type { IncomingMessage } from "node:http";
import {
  CONTROL_UI_OPERATOR_ROLE,
  CONTROL_UI_OPERATOR_SCOPES,
} from "../gateway/control-ui-contract.js";
import type {
  ControlUiMeContextResponse,
  LaunchableSessionType,
  PrivacyMode,
  RuntimeUser,
  ScopeRef,
} from "./control-ui-contract.js";

function readRequestHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function titleCaseWords(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeUserId(raw: string | null): string {
  if (!raw) {
    return "operator";
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return normalized || "operator";
}

function deriveDisplayName(userId: string, fallback: string | null): string {
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  return titleCaseWords(userId.replace(/[._-]+/g, " "));
}

function deriveRole(userId: string): RuntimeUser["role"] {
  if (userId === "igor") {
    return "main_operator";
  }
  if (userId === "stipe") {
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

function deriveGroups(userId: string): string[] {
  if (userId === "igor" || userId === "stipe" || userId === "ivan") {
    return ["OGMA"];
  }
  return [];
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
  const types: LaunchableSessionType[] = ["private_chat", "group_chat"];
  if (user.role === "admin" || user.role === "main_operator") {
    types.push("global_chat");
  }
  if (user.role === "main_operator") {
    types.push("operator_chat");
  }
  return types;
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

function deriveSelectedScope(visibleScopes: ScopeRef[]): ScopeRef | null {
  return visibleScopes[0] ?? null;
}

export function buildControlUiMeContextResponse(req: IncomingMessage): ControlUiMeContextResponse {
  const headerUserId = readRequestHeader(req, "x-openclaw-user-id");
  const headerDisplayName = readRequestHeader(req, "x-openclaw-user-name");
  const userId = normalizeUserId(headerUserId);
  const role = deriveRole(userId);
  const user: RuntimeUser = {
    id: userId,
    displayName: deriveDisplayName(userId, headerDisplayName),
    role,
    roleLabel: deriveRoleLabel(role),
    groups: deriveGroups(userId),
  };

  const visibleScopes = deriveVisibleScopes(user);
  const selectedScope = deriveSelectedScope(visibleScopes);
  const selectedPrivacyMode: PrivacyMode = selectedScope?.privacyMode ?? "private";

  return {
    user,
    groups: [...user.groups],
    visibleScopes,
    launchableSessionTypes: deriveLaunchableSessionTypes(user),
    shareTargets: deriveShareTargets(user),
    selectedScope,
    selectedPrivacyMode,
    operator: {
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    },
  };
}
