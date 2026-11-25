import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";

export function currentPolicyExec(command: string): ExecAuthorizationCommitInput {
  return {
    agentId: "main",
    matches: [],
    command,
    authorization: {
      source: "current-policy",
      security: "allowlist",
      ask: "on-miss",
      allowlistSatisfied: true,
    },
  };
}
