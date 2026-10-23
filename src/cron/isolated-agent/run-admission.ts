import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";

export function assertCronRuntimeAuthorityCandidate(params: {
  authority?: CronRuntimeAuthority;
  candidateRuntime: string;
  cliExecution: boolean;
}): void {
  const authority = params.authority;
  if (!authority) {
    return;
  }
  if (params.candidateRuntime !== authority.runtimeId || params.cliExecution) {
    throw new AgentHarnessPreflightError(
      `This automation carries ${authority.namespace} authority captured for the ${authority.runtimeId} runtime, but the selected execution runtime is ${params.candidateRuntime}. Restore that runtime and auth profile, or explicitly replace the automation's toolsAllow cap from an authenticated creator turn.`,
    );
  }
}

export type CronSandboxPlacement = {
  sessionSandboxRequired?: boolean;
  sessionSandboxed: boolean;
};

export function resolveCronSandboxPlacement(
  params: Parameters<typeof resolvePreparedSandboxRuntimeStatus>[0],
): CronSandboxPlacement {
  const status = resolvePreparedSandboxRuntimeStatus(params);
  return {
    sessionSandboxRequired: status.sandboxRequired,
    sessionSandboxed: status.sandboxed,
  };
}

export function assertCronCandidateSandboxPlacement(params: {
  sessionSandboxRequired?: boolean;
  sessionSandboxed: boolean;
  cliExecution: boolean;
  executionProvider: string;
}): void {
  if (!params.cliExecution || (!params.sessionSandboxed && !params.sessionSandboxRequired)) {
    return;
  }
  throw new AgentHarnessPreflightError(
    `This automation belongs to a sandboxed session, but resolved execution provider ${params.executionProvider} runs on the host and cannot honor the sandbox. Override agents.entries.<id>.subagents.model, agents.defaults.subagents.model, or the automation payload model with an API-backed provider (and clear any pinned CLI runtime override), or change the agent's sandbox policy explicitly.`,
  );
}
