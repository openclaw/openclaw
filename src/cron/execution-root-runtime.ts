const CRON_EXECUTION_ROOT_RUNTIME_ERROR =
  "collection review requires a runtime that enforces the Workshop root through OpenClaw tools";

export class CronExecutionRootRuntimeError extends Error {
  constructor() {
    super(CRON_EXECUTION_ROOT_RUNTIME_ERROR);
    this.name = "CronExecutionRootRuntimeError";
  }
}

/** Shared admission predicate for turns that must enforce a host-owned execution root. */
export function supportsCronExecutionRoot(runtime: string, rootedCliExecution: boolean): boolean {
  // Codex required-root turns use host tools and attest the restricted native surface before dispatch.
  return runtime === "openclaw" || runtime === "codex" || rootedCliExecution;
}

export function assertCronExecutionRootRuntime(
  executionRoot: string | undefined,
  runtime: string,
  rootedCliExecution: boolean,
): void {
  if (executionRoot && !supportsCronExecutionRoot(runtime, rootedCliExecution)) {
    throw new CronExecutionRootRuntimeError();
  }
}
