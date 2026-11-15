import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";

// Independent expected values, verified through real activation in service.role-presets.test.ts.
export const MEMBER_ROLE_PRESETS: Record<"operator" | "viewer", GatewayOperatorRoleDefinition> = {
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
  viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.read"] },
};
