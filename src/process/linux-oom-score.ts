import fs from "node:fs";
import { readChildRuntimeViability } from "../infra/child-runtime-viability.js";
import {
  isWrapped,
  OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT,
  OOM_SCORE_WRAP_SCRIPT,
  OOM_SCORE_WRAP_SHELL,
  raiseChildOomScore,
  shouldAdjustChildOomScore,
  type OomWrapOptions,
} from "./linux-oom-score-spawn.js";

export {
  resolveOomScoreWrappedCommand,
  spawnOomScoreAdjusted,
  spawnWithInheritedOomScore,
  type OomWrapOptions,
} from "./linux-oom-score-spawn.js";

/**
 * Linux children inherit the Gateway's OOM score, leaving the larger Gateway
 * vulnerable under memory pressure (#70404). Raise children to 1000 through a
 * shell that execs the command, or after native spawn when argv0 must be retained.
 * Raising a same-user child's score needs no CAP_SYS_RESOURCE.
 * OPENCLAW_CHILD_OOM_SCORE_ADJ=0 (also false/no/off) opts out per child or process.
 */

// Env keys that can make /bin/sh (especially Bash invoked as sh) execute or
// expose caller-influenced startup behavior before the final `exec`. Stripped
// when we wrap so the shim can't become an env-controlled code-exec primitive.
const SHELL_INIT_ENV_CARRIERS = [
  ["BASH_ENV", "OC_INTERNAL_OOM_EXEC_BASH_ENV"],
  ["ENV", "OC_INTERNAL_OOM_EXEC_ENV"],
  ["CDPATH", "OC_INTERNAL_OOM_EXEC_CDPATH"],
  ["PS4", "OC_INTERNAL_OOM_EXEC_PS4"],
] as const;
const NON_RESTORABLE_BASH_ENV_KEY = /^(?:SHELLOPTS|BASHOPTS|BASH_FUNC_.*)$/u;

let cachedShellAvailable: boolean | null = null;
function defaultShellAvailable(): boolean {
  if (cachedShellAvailable !== null) {
    return cachedShellAvailable;
  }
  try {
    cachedShellAvailable = fs.statSync(OOM_SCORE_WRAP_SHELL).isFile();
  } catch {
    cachedShellAvailable = false;
  }
  return cachedShellAvailable;
}

export type OomScoreAdjustedSpawn = {
  command: string;
  args: string[];
  argv0?: string;
  env: NodeJS.ProcessEnv | undefined;
  wrapped: boolean;
  afterSpawn?: (pid: number | undefined) => void;
};

function hardenShellEnv(baseEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  for (const [key] of SHELL_INIT_ENV_CARRIERS) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    if (NON_RESTORABLE_BASH_ENV_KEY.test(key)) {
      delete next[key];
    }
  }
  return next;
}

function prepareOomScoreAdjustedSpawnWithExecEnvPolicy(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
  preserveExecEnv = false,
): OomScoreAdjustedSpawn {
  const copy = [...args];
  const directSpawn: OomScoreAdjustedSpawn = {
    command,
    args: copy,
    ...(options?.argv0 === undefined ? {} : { argv0: options.argv0 }),
    env: options?.env,
    wrapped: false,
  };
  // POSIX sh lacks `exec --`; a leading dash would become an exec option.
  if (
    !command ||
    command.startsWith("-") ||
    !shouldAdjustChildOomScore(options) ||
    // A shell would start successfully and hide the removed runtime's native ENOENT.
    (command === process.execPath && !readChildRuntimeViability().available)
  ) {
    return directSpawn;
  }
  if (options?.argv0 !== undefined && options.argv0 !== command) {
    // POSIX sh cannot preserve argv0. Adjust immediately after native spawn;
    // the child (and early descendants) can run briefly at the inherited score.
    return { ...directSpawn, afterSpawn: raiseChildOomScore };
  }
  if (!(options?.shellAvailable ?? defaultShellAvailable)()) {
    return directSpawn;
  }
  if (!preserveExecEnv && isWrapped(command, copy)) {
    return { command, args: copy, env: hardenShellEnv(options?.env), wrapped: true };
  }
  const effectiveEnv = options?.env ?? process.env;
  if (
    preserveExecEnv &&
    Object.entries(effectiveEnv).some(
      ([key, value]) => value !== undefined && NON_RESTORABLE_BASH_ENV_KEY.test(key),
    )
  ) {
    // Bash consumes these readonly/imported controls before the shim can
    // neutralize and restore them, so only direct spawn preserves exact env.
    return directSpawn;
  }
  const wrappedEnv = hardenShellEnv(effectiveEnv);
  if (preserveExecEnv) {
    for (const [key, carrier] of SHELL_INIT_ENV_CARRIERS) {
      if (effectiveEnv[carrier] !== undefined) {
        return directSpawn;
      }
      delete wrappedEnv[carrier];
      if (effectiveEnv[key] !== undefined) {
        wrappedEnv[carrier] = effectiveEnv[key];
      }
    }
  }
  const wrapScript = preserveExecEnv ? OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT : OOM_SCORE_WRAP_SCRIPT;
  return {
    command: OOM_SCORE_WRAP_SHELL,
    args: ["-c", wrapScript, command, ...copy],
    env: wrappedEnv,
    wrapped: true,
  };
}

export function prepareOomScoreAdjustedSpawn(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
): OomScoreAdjustedSpawn {
  return prepareOomScoreAdjustedSpawnWithExecEnvPolicy(command, args, options);
}

export function prepareOomScoreAdjustedSpawnPreservingExecEnv(
  command: string,
  args: readonly string[] = [],
  options?: OomWrapOptions,
): OomScoreAdjustedSpawn {
  return prepareOomScoreAdjustedSpawnWithExecEnvPolicy(command, args, options, true);
}
