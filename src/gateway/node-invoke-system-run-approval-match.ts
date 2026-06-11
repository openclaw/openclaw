import fs from "node:fs";
import path from "node:path";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  missingSystemRunApprovalBinding,
  matchSystemRunApprovalBinding,
  type SystemRunApprovalMatchResult,
} from "../infra/system-run-approval-binding.js";

type SystemRunApprovalBinding = {
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

function canonicalizeCwdForApproval(cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return cwd;
  }
}

export function evaluateSystemRunApprovalMatch(params: {
  argv: string[];
  request: ExecApprovalRequestPayload;
  binding: SystemRunApprovalBinding;
}): SystemRunApprovalMatchResult {
  if (params.request.host !== "node") {
    return requestMismatch();
  }

  const actualBinding = buildSystemRunApprovalBinding({
    argv: params.argv,
    cwd: canonicalizeCwdForApproval(params.binding.cwd),
    agentId: params.binding.agentId,
    sessionKey: params.binding.sessionKey,
    env: params.binding.env,
  });

  const expectedBinding = params.request.systemRunBinding;
  if (!expectedBinding) {
    return missingSystemRunApprovalBinding({
      actualEnvKeys: actualBinding.envKeys,
    });
  }
  return matchSystemRunApprovalBinding({
    expected: expectedBinding,
    actual: actualBinding.binding,
    actualEnvKeys: actualBinding.envKeys,
  });
}
