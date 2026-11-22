// Revalidates and commits exec authority against the current policy.
import {
  buildAllowlistEntryMatchKey,
  createExecApprovalPolicySnapshot,
} from "./exec-approvals-allow-always.js";
import { assertCurrentUsageAuthorization } from "./exec-approvals-authorization.kernel.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import { commitExecAuthorizations } from "./exec-approvals-store.js";

export type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";

export async function commitExecAuthorizationLocked(
  input: ExecAuthorizationCommitInput,
): Promise<() => void> {
  const params = structuredClone(input);
  return retainedAuthorization(params, await commitExecAuthorizations(params));
}

function retainedAuthorization(
  params: ExecAuthorizationCommitInput,
  { file, readCurrent }: Awaited<ReturnType<typeof commitExecAuthorizations>>,
): () => void {
  const matchKeys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  // Our own allow-always write is part of the committed policy. Later checks
  // only read; a PTY retry must neither replay that write nor reject its result.
  const authorization = {
    ...params.authorization,
    policySnapshot: createExecApprovalPolicySnapshot({
      file,
      agentId: params.agentId,
    }),
  };
  return () =>
    assertCurrentUsageAuthorization({
      file: readCurrent(),
      agentId: params.agentId,
      command: params.command,
      matchKeys,
      authorization,
    });
}
