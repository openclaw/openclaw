import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import type { ProcessExecutionIntent } from "./linux-exec-cgroup.js";

/** prlimit execs in place, so command descendants inherit the limit without changing the host. */
export function prepareAgentCoreDumpLimit(
  command: string,
  args: string[],
  intent: ProcessExecutionIntent | undefined,
): { command: string; args: string[] } {
  if (process.platform !== "linux" || intent !== "agent-tool") {
    return { command, args };
  }
  const prlimit = resolveSystemBin("prlimit");
  if (!prlimit) {
    throw new Error(
      "Linux agent execution requires prlimit; install util-linux in a system directory.",
    );
  }
  return { command: prlimit, args: ["--core=0:0", "--", command, ...args] };
}
