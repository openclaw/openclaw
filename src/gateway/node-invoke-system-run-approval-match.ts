import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";

export type SystemRunApprovalBinding = {
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
};

function argvMatchesRequest(requestedArgv: string[], argv: string[]): boolean {
  if (requestedArgv.length === 0 || requestedArgv.length !== argv.length) {
    return false;
  }
  for (let i = 0; i < requestedArgv.length; i += 1) {
    if (requestedArgv[i] !== argv[i]) {
      return false;
    }
  }
  return true;
}

export function approvalMatchesSystemRunRequest(params: {
  cmdText: string;
  argv: string[];
  request: ExecApprovalRequestPayload;
  binding: SystemRunApprovalBinding;
}): boolean {
  if (params.request.host !== "node") {
    return false;
  }

  const requestedArgv = params.request.commandArgv;
  if (Array.isArray(requestedArgv)) {
    if (!argvMatchesRequest(requestedArgv, params.argv)) {
      return false;
    }
  } else if (!params.cmdText || params.request.command !== params.cmdText) {
    return false;
  }

  if ((params.request.cwd ?? null) !== params.binding.cwd) {
    return false;
  }
  if ((params.request.agentId ?? null) !== params.binding.agentId) {
    return false;
  }
  if ((params.request.sessionKey ?? null) !== params.binding.sessionKey) {
    return false;
  }

  return true;
}
