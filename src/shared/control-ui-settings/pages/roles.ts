import { defineSettingsPage } from "../define.js";

export const ROLES_SETTINGS = defineSettingsPage({
  path: "/settings/roles",
  title: "Roles",
  settings: {
    "gateway.roles.default": { label: "Role for people without one" },
  },
});

// Like the agent editor, the URL selects the entity; each role has the same field IDs.
export const ROLE_EDITOR_SETTINGS = defineSettingsPage({
  path: "/settings/roles",
  title: "Roles",
  role: true,
  settings: {
    "role.sessions.others": { label: "Other people's sessions" },
    "role.sandbox": { label: "Sandbox their own sessions" },
    "role.agents": { label: "Agents" },
    "role.sessions.maxInvitedAccess": { label: "Most an invitation can give them" },
    "role.sessions.invitedPermission": { label: "Agent permission on their turns" },
    "role.sessions.invitedTools": { label: "Tools on their turns" },
    "role.scopes.*": { label: "Gateway permission" },
  },
});
