import type { GatewayOperatorRoleDefinition as Role } from "../../config/types.gateway.js";

// Independent expected values, verified through real activation in service.role-presets.test.ts.
export const MEMBER_ROLE_PRESETS: Record<"admin" | "operator" | "viewer" | "guest", Role> = {
  admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
  operator: {
    sessions: { others: "write" },
    agents: "*",
    scopes: [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.talk",
    ],
  },
  guest: {
    sessions: { others: "invited", maxInvitedAccess: "send" },
    agents: "*",
    scopes: ["operator.sessions.read", "operator.sessions.write"],
    sandbox: "required",
  },
  viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.read"] },
};
