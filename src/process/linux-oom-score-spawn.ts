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
import { parseBooleanValue } from "../utils/boolean.js";

// Small spawn owners must not load Gateway runtime recovery or logging.
const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
export const OOM_SCORE_WRAP_SHELL = "/bin/sh";
export const OOM_SCORE_WRAP_SCRIPT =
  'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';

export const OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT = [
  'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; if [ "${OC_INTERNAL_OOM_EXEC_BASH_ENV+x}" = x ]; then BASH_ENV="$OC_INTERNAL_OOM_EXEC_BASH_ENV"; export BASH_ENV; fi; unset OC_INTERNAL_OOM_EXEC_BASH_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_ENV+x}" = x ]; then ENV="$OC_INTERNAL_OOM_EXEC_ENV"; export ENV; fi; unset OC_INTERNAL_OOM_EXEC_ENV',
  'if [ "${OC_INTERNAL_OOM_EXEC_CDPATH+x}" = x ]; then CDPATH="$OC_INTERNAL_OOM_EXEC_CDPATH"; export CDPATH; fi; unset OC_INTERNAL_OOM_EXEC_CDPATH',
  'if [ "${OC_INTERNAL_OOM_EXEC_PS4+x}" = x ]; then PS4="$OC_INTERNAL_OOM_EXEC_PS4"; export PS4; fi; unset OC_INTERNAL_OOM_EXEC_PS4; exec "$0" "$@"',
].join("; ");

export type OomWrapOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv0?: string;
  shellAvailable?: () => boolean;
};

export function raiseChildOomScore(pid: number | undefined): void {
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

export function shouldAdjustChildOomScore(options: OomWrapOptions | undefined): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") {
    return false;
  }
  const value =
    options?.env?.[CHILD_OOM_SCORE_ADJ_ENV_KEY] ?? process.env[CHILD_OOM_SCORE_ADJ_ENV_KEY];
  return parseBooleanValue(value) !== false;
}

export function isWrapped(command: string, args: readonly string[]): boolean {
  return command === OOM_SCORE_WRAP_SHELL && args[0] === "-c" && args[1] === OOM_SCORE_WRAP_SCRIPT;
}

/** Diagnostics attribute the final command without changing the wrapper's execution policy. */
export function resolveOomScoreWrappedCommand(
  command: string,
  args: readonly string[],
): string | undefined {
  return command === OOM_SCORE_WRAP_SHELL &&
    args[0] === "-c" &&
    (args[1] === OOM_SCORE_WRAP_SCRIPT || args[1] === OOM_SCORE_RESTORE_EXEC_ENV_SCRIPT) &&
    args[2]
    ? args[2]
    : undefined;
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
    return spawnOomScoreAdjusted(command, args, options);
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
