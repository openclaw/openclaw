// Revalidates and commits exec authority against the current policy.
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  buildAllowlistEntryMatchKey,
  createExecApprovalPolicySnapshot,
} from "./exec-approvals-allow-always.js";
import { assertCurrentUsageAuthorization } from "./exec-approvals-authorization.kernel.js";
import type {
  ExecApprovalUsageAuthorization,
  ExecAuthorizationCommitInput,
} from "./exec-approvals-contracts.js";
import { commitExecAuthorizations } from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";

export async function recordAllowlistMatchesUse(
  params: {
    agentId: string | undefined;
    matches: readonly ExecAllowlistEntry[];
    command: string;
    resolvedPath?: string;
    authorization: ExecApprovalUsageAuthorization;
    assertCurrent?: () => void;
  },
  context?: OpenClawStateWorkerContext,
): Promise<() => void> {
  const input: ExecAuthorizationCommitInput = structuredClone({
    agentId: params.agentId,
    matches: [...params.matches],
    command: params.command,
    resolvedPath: params.resolvedPath,
    authorization: params.authorization,
  });
  const committed = await commitExecAuthorizations(input, params.assertCurrent, context);
  return retainedAuthorization(input, committed);
}

export async function commitExecAuthorizationLocked(
  input: ExecAuthorizationCommitInput,
): Promise<() => void> {
  const params = structuredClone(input);
  return retainedAuthorization(params, await commitExecAuthorizations(params));
}

function retainedAuthorization(
  params: ExecAuthorizationCommitInput,
  { snapshot, readCurrent }: Awaited<ReturnType<typeof commitExecAuthorizations>>,
): () => void {
  const matchKeys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  // Our own allow-always write is part of the committed policy. Later checks
  // only read; a PTY retry must neither replay that write nor reject its result.
  const authorization = {
    ...params.authorization,
    policySnapshot: createExecApprovalPolicySnapshot({
      file: snapshot.file,
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
