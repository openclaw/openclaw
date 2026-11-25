// Revalidates and commits exec authority against the current policy.
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import { commitExecAuthorizations } from "./exec-approvals-store.js";

export type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";

/** The commit checks the policy once; the returned guard only observes Stop before launch. */
export async function commitExecAuthorizationLocked(
  input: ExecAuthorizationCommitInput,
): Promise<() => void> {
  const { readCurrent } = await commitExecAuthorizations(input);
  return () => void readCurrent();
}
