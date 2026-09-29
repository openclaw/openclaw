// Revalidates and commits exec authority against the current policy.
import {
  buildAllowlistEntryMatchKey,
  createExecApprovalPolicySnapshot,
} from "./exec-approvals-allow-always.js";
import {
  applyRecordedAllowlistUse,
  assertCurrentUsageAuthorization,
} from "./exec-approvals-authorization.kernel.js";
import type {
  ExecApprovalUsageAuthorization,
  ExecAuthorizationCommitInput,
} from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import {
  commitExecAuthorizations,
  replaceExecApprovalsSnapshot,
  updateExecApprovalsSync,
} from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
): void {
  recordAllowlistMatchesUse({
    approvals,
    agentId,
    matches: [entry],
    command,
    resolvedPath,
  });
}

export function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): void {
  if (params.matches.length === 0 && !params.authorization) {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) => applyRecordedAllowlistUse({ ...params, file }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

export async function commitExecAuthorizationLocked(
  input: ExecAuthorizationCommitInput,
): Promise<() => void> {
  const params = structuredClone(input);
  const { snapshot, readCurrent } = await commitExecAuthorizations(params);
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
