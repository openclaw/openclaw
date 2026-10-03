import type { ExecApprovalsSetParams } from "../../packages/gateway-protocol/src/schema/exec-approvals.js";

type ExecApprovalsAgent = NonNullable<ExecApprovalsSetParams["file"]["agents"]>[string];

export type McpToolGrant = NonNullable<ExecApprovalsAgent["mcpTools"]>[number];

// Serialized allowlist entries stored with enough command context to explain
// why an approval can be reused later.
export type ExecAllowlistEntry = NonNullable<ExecApprovalsAgent["allowlist"]>[number];

export type AllowAlwaysPattern = {
  pattern: string;
  argPattern?: string;
};
