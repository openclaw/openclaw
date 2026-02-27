import type { SystemRunApprovalBindingV1 } from "../infra/exec-approvals.js";
import type { ExecApprovalRequestPayload } from "./exec-approval-manager.js";
import {
  buildSystemRunApprovalBindingV1,
  missingSystemRunApprovalBindingV1,
  matchSystemRunApprovalBindingV1,
  type SystemRunApprovalMatchResult,
} from "../infra/system-run-approval-binding.js";

export type SystemRunApprovalBinding = {
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  env?: unknown;
};

function requestMismatch(): SystemRunApprovalMatchResult {
  return {
    ok: false,
    code: "APPROVAL_REQUEST_MISMATCH",
    message: "approval id does not match request",
  };
}

export { toSystemRunApprovalMismatchError } from "../infra/system-run-approval-binding.js";
export type { SystemRunApprovalMatchResult } from "../infra/system-run-approval-binding.js";

export function evaluateSystemRunApprovalMatch(params: {
  argv: string[];
  request: ExecApprovalRequestPayload;
  binding: SystemRunApprovalBinding;
}): SystemRunApprovalMatchResult {
  if (params.request.host !== "node") {
    return requestMismatch();
  }

  const actualBinding = buildSystemRunApprovalBindingV1({
    argv: params.argv,
    cwd: params.binding.cwd,
    agentId: params.binding.agentId,
    sessionKey: params.binding.sessionKey,
    env: params.binding.env,
  });

  const expectedBindingRaw = params.request.systemRunBindingV1;
  if (!expectedBindingRaw) {
    return missingSystemRunApprovalBindingV1({
      actualEnvKeys: actualBinding.envKeys,
    });
  }
  const expectedBinding = expectedBindingRaw as SystemRunApprovalBindingV1;
  return matchSystemRunApprovalBindingV1({
    expected: expectedBinding,
    actual: actualBinding.binding,
    actualEnvKeys: actualBinding.envKeys,
  });
}
