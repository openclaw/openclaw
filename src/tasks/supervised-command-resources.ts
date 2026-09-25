import type { NodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import {
  awaitSupervisedProcessScopeClosed,
  buildSupervisedProcessScopeArgv,
  inspectSupervisedProcessScope,
  isSealedSupervisedProcessScopeAbsent,
  isSupervisedProcessBootRetired,
  isSupervisedProcessScopeClosed,
  supervisedProcessScopeName,
  terminateSupervisedProcessScope,
  type SupervisedProcessResourceLimits,
  type SupervisedProcessScopeIdentity,
} from "./supervised-process-resources.js";

// Preserve the existing command wire identity and scope names. Attempts use the
// neutral resourceId shape directly; they never fabricate a command execution.
export type SupervisedCommandResourceLimits = SupervisedProcessResourceLimits;
export type SupervisedCommandScopeIdentity = Omit<SupervisedProcessScopeIdentity, "resourceId"> & {
  executionId: string;
};
export const supervisedCommandScopeName = supervisedProcessScopeName;
export const buildSupervisedCommandScopeArgv = buildSupervisedProcessScopeArgv;
export const isSealedSupervisedCommandScopeAbsent = isSealedSupervisedProcessScopeAbsent;

function processIdentity(identity: SupervisedCommandScopeIdentity): SupervisedProcessScopeIdentity {
  const { executionId, ...rest } = identity;
  return { resourceId: executionId, ...rest };
}
export function isSupervisedCommandBootRetired(identity: SupervisedCommandScopeIdentity) {
  return isSupervisedProcessBootRetired(processIdentity(identity));
}
export function isSupervisedCommandScopeClosed(identity: SupervisedCommandScopeIdentity) {
  return isSupervisedProcessScopeClosed(processIdentity(identity));
}
export function awaitSupervisedCommandScopeClosed(
  identity: SupervisedCommandScopeIdentity,
  timeoutMs?: number,
) {
  return awaitSupervisedProcessScopeClosed(processIdentity(identity), timeoutMs);
}
export function terminateSupervisedCommandScope(
  identity: SupervisedCommandScopeIdentity,
  assertCurrent: () => void,
) {
  return terminateSupervisedProcessScope(processIdentity(identity), assertCurrent);
}
export async function inspectSupervisedCommandScope(params: {
  executionId: string;
  limits: SupervisedCommandResourceLimits;
  expectedProcess: NodeWorkerProcessIdentity;
  assertCurrent: () => void;
}): Promise<SupervisedCommandScopeIdentity> {
  const { resourceId, ...rest } = await inspectSupervisedProcessScope({
    resourceId: params.executionId,
    limits: params.limits,
    expectedProcess: params.expectedProcess,
    assertCurrent: params.assertCurrent,
  });
  return { executionId: resourceId, ...rest };
}
