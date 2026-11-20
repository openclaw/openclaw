import type { OpenClawConfig } from "../config/types.openclaw.js";

export function createAdminMemberRoleConfig(): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
        },
      },
    },
  };
}
