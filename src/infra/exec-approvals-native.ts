import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { ExecApprovalsNativeCommitParams } from "../../packages/gateway-protocol/src/schema/exec-approvals.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";
import { commitExecAuthorizations } from "./exec-approvals-store.js";

export type NativeExecAuthorization = Omit<
  SchemaContract<ExecApprovalsNativeCommitParams>,
  "expectedOwnerId" | "authorization"
> & {
  authorization: Pick<
    ExecApprovalUsageAuthorization,
    | "source"
    | "security"
    | "ask"
    | "allowlistSatisfied"
    | "policySnapshot"
    | "requireAutoAllowSkills"
  >;
};

/** The live native caller owns its bound argv/cwd and rechecks them immediately before spawn. */
export async function commitNativeExecAuthorization(
  input: NativeExecAuthorization,
  assertCurrent: () => void,
  context: OpenClawStateWorkerContext,
): Promise<{ authorized: true }> {
  assertCurrent();
  if (
    (input.authorization.source === "current-policy" ||
      input.authorization.source === "ask-fallback") &&
    input.authorization.security === "allowlist" &&
    input.uses.length === 0 &&
    !input.authorization.requireAutoAllowSkills
  ) {
    throw new Error("Native exec allowlist authorization requires a matched rule.");
  }
  const grantedMatches = input.grants.map((grant) => ({
    ...grant,
    source: "allow-always" as const,
  }));
  await commitExecAuthorizations(
    {
      agentId: input.agentId,
      command: input.command,
      matches: [
        ...input.uses.map(({ match, resolvedPath }) => ({ ...match, resolvedPath })),
        ...grantedMatches,
      ],
      authorization: input.authorization,
      ...(input.grants.length
        ? {
            allowAlwaysDecision: {
              kind: "patterns" as const,
              patterns: input.grants,
            },
          }
        : {}),
      requireCommit: true,
    },
    assertCurrent,
    context,
  );
  assertCurrent();
  return { authorized: true };
}
