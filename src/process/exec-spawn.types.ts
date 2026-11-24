import type { CommandStdinFile } from "./command-stdin-file.js";
import type { ProcessExecutionIntent } from "./linux-exec-cgroup.js";
import type { CommandSpawnOptions } from "./spawn-broker/execa-types.js";

/** An admitted owner can narrow every command launched within its cleanup scope. */
export type CommandProcessInvocationPolicy = (input: {
  argv: string[];
  cwd: string | URL | undefined;
  env: NodeJS.ProcessEnv;
}) => { argv: string[]; env: NodeJS.ProcessEnv };

export type SpawnCommandOptions = CommandSpawnOptions & {
  stdinFile?: CommandStdinFile;
  executionIntent?: ProcessExecutionIntent;
  executionScopeKey?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Operation-owned output of resolveCommandEnv; no ambient environment is merged again. */
  preparedEnv?: NodeJS.ProcessEnv;
  executionTimeoutMs?: number;
  /** The command runner routes scope cancellation through its termination owner. */
  inheritScopeCancellation?: boolean;
};
