import type { GatewayOperatorRoleDefinition as Role } from "../../config/types.gateway.js";

// Independent expected values, verified through real activation in service.role-presets.test.ts.
export const MEMBER_ROLE_PRESETS: Record<"operator" | "viewer" | "guest", Role> = {
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
    sessions: { others: "view" },
    agents: "*",
    scopes: ["operator.sessions.write"],
    sandbox: "required",
  },
  viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.read"] },
};
