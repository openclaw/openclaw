import type { ProcessExecutionIntent } from "./linux-exec-cgroup.js";

const prlimit = "/usr/bin/prlimit";
const coreLimit = "--core=0:0";

/** prlimit execs in place, so command descendants inherit the limit without changing the host. */
export function prepareAgentCoreDumpLimit(
  command: string,
  args: string[],
  intent: ProcessExecutionIntent | undefined,
): { command: string; args: string[] } {
  return process.platform === "linux" && intent === "agent-tool"
    ? { command: prlimit, args: [coreLimit, "--", command, ...args] }
    : { command, args };
}
