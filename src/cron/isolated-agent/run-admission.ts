import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";

// A CLI child in its parent's workspace runs native tools no tool check sees, so
// its process also ends when the parent resets.
export function resolveCliChildAbortSignal(
  runSignal: AbortSignal | undefined,
  parentSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!parentSignal) {
    return runSignal;
  }
  return runSignal ? AbortSignal.any([runSignal, parentSignal]) : parentSignal;
}

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

/** Sandbox placement facts for one isolated run; resolved once from the prepared session entry. */
export type CronSandboxPlacement = {
  sessionSandboxRequired?: boolean | undefined;
  sessionSandboxed: boolean;
};

/**
 * Resolves the run's sandbox placement facts from the prepared session entry,
 * plus a requirement inherited from a sandboxed parent conversation. An existing
 * cron root may predate that requirement, so its row alone cannot carry it.
 */
export function resolveCronSandboxPlacement(
  params: Parameters<typeof resolvePreparedSandboxRuntimeStatus>[0] & {
    inheritedSandbox?: "required";
  },
): CronSandboxPlacement {
  const { inheritedSandbox, ...statusParams } = params;
  const status = resolvePreparedSandboxRuntimeStatus(statusParams);
  return {
    sessionSandboxRequired: status.sandboxRequired || inheritedSandbox === "required",
    sessionSandboxed: status.sandboxed,
  };
}

/**
 * Sandboxed sessions never dispatch to host-executed CLI backends.
 *
 * A CLI backend spawns a local AI CLI on the gateway host; its native tools run
 * with the gateway OS user outside any configured Docker sandbox. When this
 * session is classified as sandboxed (the configured sandbox mode covers this
 * session key) or carries required sandbox isolation (a creator-mandated
 * containment), admitting a CLI candidate would silently move tool execution
 * from the container to the host while `openclaw sandbox explain` still
 * reports the session as sandboxed. Fail closed instead of dispatching: override
 * `agents.entries.<id>.subagents.model`, `agents.defaults.subagents.model`, or
 * the automation payload `model` to a sandbox-compatible runtime (clearing any
 * pinned CLI runtime override), or change the agent's sandbox policy explicitly.
 */
export function assertCronCandidateSandboxPlacement(params: {
  sessionSandboxRequired?: boolean | undefined;
  sessionSandboxed: boolean;
  cliExecution: boolean;
  executionProvider: string;
}): void {
  if (!params.cliExecution) {
    return;
  }
  // Unsandboxed sessions keep CLI execution: the sandbox classification
  // already folds the configured mode ("all", or "non-main" away from the
  // agent's main session) into the sessionSandboxed fact for this key.
  if (!params.sessionSandboxed && !params.sessionSandboxRequired) {
    return;
  }
  throw new AgentHarnessPreflightError(
    `This automation belongs to a sandboxed session, but resolved execution provider ${params.executionProvider} runs on the host and cannot honor the sandbox. Override agents.entries.<id>.subagents.model, agents.defaults.subagents.model, or the automation payload model with an API-backed provider (and clear any pinned CLI runtime override), or change the agent's sandbox policy explicitly.`,
  );
}
