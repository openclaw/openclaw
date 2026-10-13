import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import { readChildRuntimeViability } from "../infra/child-runtime-viability.js";
import { parseBooleanValue } from "../utils/boolean.js";

/**
 * Linux children inherit the Gateway's OOM score, leaving the larger Gateway
 * vulnerable under memory pressure (#70404). Raise children to 1000 through a
 * shell that execs the command, or after native spawn when argv0 must be retained.
 * Raising a same-user child's score needs no CAP_SYS_RESOURCE.
 * OPENCLAW_CHILD_OOM_SCORE_ADJ=0 (also false/no/off) opts out per child or process.
 */

const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
const OOM_SCORE_WRAP_SHELL = "/bin/sh";
const OOM_SCORE_WRAP_SCRIPT = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';

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
const OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT = [
  'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; if [ "${OC_INTERNAL_OOM_EXEC_BASH_ENV+x}" = x ]; then BASH_ENV="$OC_INTERNAL_OOM_EXEC_BASH_ENV"; export BASH_ENV; fi; unset OC_INTERNAL_OOM_EXEC_BASH_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_ENV+x}" = x ]; then ENV="$OC_INTERNAL_OOM_EXEC_ENV"; export ENV; fi; unset OC_INTERNAL_OOM_EXEC_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_CDPATH+x}" = x ]; then CDPATH="$OC_INTERNAL_OOM_EXEC_CDPATH"; export CDPATH; fi; unset OC_INTERNAL_OOM_EXEC_CDPATH',
  'if [ "${OC_INTERNAL_OOM_EXEC_PS4+x}" = x ]; then PS4="$OC_INTERNAL_OOM_EXEC_PS4"; export PS4; fi; unset OC_INTERNAL_OOM_EXEC_PS4; exec "$0" "$@"',
].join("; ");

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

export type OomWrapOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv0?: string;
  shellAvailable?: () => boolean;
};

export type OomScoreAdjustedSpawn = {
  command: string;
  args: string[];
  argv0?: string;
  env: NodeJS.ProcessEnv | undefined;
  wrapped: boolean;
  afterSpawn?: (pid: number | undefined) => void;
};

function raiseChildOomScore(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    fs.writeFileSync(`/proc/${pid}/oom_score_adj`, "1000");
  } catch {
    // Best effort, like the shell shim: /proc may be unavailable or the child already gone.
  }
}

/** Native spawn semantics with the shared Linux child OOM policy. */
export function spawnOomScoreAdjusted(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioNull | StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable | null, Readable, Readable>;
export function spawnOomScoreAdjusted(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess;
export function spawnOomScoreAdjusted(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, options);
  if (!options.shell && shouldAdjustChildOomScore(options)) {
    raiseChildOomScore(child.pid);
  }
  return child;
}

function shouldAdjustChildOomScore(options: OomWrapOptions | undefined): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") {
    return false;
  }
  const value =
    options?.env?.[CHILD_OOM_SCORE_ADJ_ENV_KEY] ?? process.env[CHILD_OOM_SCORE_ADJ_ENV_KEY];
  return parseBooleanValue(value) !== false;
}

function isWrapped(command: string, args: readonly string[]): boolean {
  return command === OOM_SCORE_WRAP_SHELL && args[0] === "-c" && args[1] === OOM_SCORE_WRAP_SCRIPT;
}

/** Only small spawn owners may temporarily raise their score; never call from the Gateway. */
export function spawnWithInheritedOomScore(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (
    process.platform !== "linux" ||
    !isWrapped(command, args) ||
    !args[2] ||
    options.shell ||
    options.argv0 !== undefined
  ) {
    const child = spawn(command, args, options);
    if (!options.shell && options.argv0 !== undefined) {
      prepareOomScoreAdjustedSpawn(command, args, options).afterSpawn?.(child.pid);
    }
    return child;
  }
  let scoreFd: number | undefined;
  let original: string;
  try {
    scoreFd = fs.openSync("/proc/self/oom_score_adj", "r+");
    original = fs.readFileSync(scoreFd, "utf8").trim();
    fs.writeSync(scoreFd, "1000", 0, "utf8");
  } catch {
    if (scoreFd !== undefined) {
      fs.closeSync(scoreFd);
    }
    return spawn(command, args, options);
  }
  try {
    // No await: only this fork inherits the raised score, including its earliest descendants.
    return spawn(args[2], args.slice(3), options);
  } finally {
    try {
      // Linux permits restoring the inherited minimum without CAP_SYS_RESOURCE.
      fs.writeSync(scoreFd, original, 0, "utf8");
    } catch {
      // Preserve the child handle so its owner can still supervise and clean it up.
      process.emitWarning("Could not restore spawn owner's Linux OOM score");
    } finally {
      fs.closeSync(scoreFd);
    }
  }
}

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
