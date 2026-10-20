import type { SpawnResult } from "../process/exec-result.js";
import type { CommandOptions } from "../process/exec.js";

/** Runs package-manager commands with timeout and environment control. */
export type CommandRunner = (
  argv: string[],
  options: Required<Pick<CommandOptions, "timeoutMs">> & Pick<CommandOptions, "cwd" | "env">,
) => Promise<
  Pick<SpawnResult, "stdout" | "stderr" | "code"> &
    Partial<Pick<SpawnResult, "signal" | "killed" | "termination">>
>;
