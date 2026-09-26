import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isForegroundGatewayRunArgv } from "../cli/gateway-run-argv.js";
import { execLaunchctl, formatLaunchctlResultDetail } from "../daemon/launchd-exec.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { formatErrorMessage } from "./errors.js";
import {
  isRespawnedByLauncher,
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  resolveLauncherStopTimeoutMs,
} from "./gateway-shutdown-budget.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

type LaunchdStopTimeout = { timeoutMs: number; source: string };

/**
 * What inspecting the job established, which is two independent answers.
 *
 * `stop` is a deadline launchd is enforcing on this process, and it is null
 * whenever none was established: this is not a launchd job, launchd is not the
 * one stopping it, or the job could not be inspected at all. Only a non-null
 * `stop` may be spent as a native stop budget.
 *
 * `warning` is what the operator needs to hear, and it is deliberately separate.
 * A failed inspection has something to report without having found a deadline,
 * and reporting the platform-neutral policy as if it came from launchd is what
 * would let an unverified number cap a longer requested restart drain.
 */
export type LaunchdStopRead = { stop: LaunchdStopTimeout | null; warning?: string };

const LAUNCHCTL_PRINT_TIMEOUT_MS = 2_000;

/**
 * Resolve the gui domain locally. `launchd-runtime.ts` exports an equivalent,
 * but it also pulls service installation, ownership and port probing into
 * whatever imports it, and this runs on the Gateway shutdown path.
 */
function resolveLaunchdDomains(label: string): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  // A LaunchDaemon and a LaunchAgent can carry the same label in different
  // domains, so each is a candidate and the pid decides which one is ours.
  // A service account with no logged-in session has no gui domain at all, and
  // its per-user jobs live in `user/<uid>`, so both user domains are checked.
  return [`system/${label}`, `gui/${uid}/${label}`, `user/${uid}/${label}`];
}

/**
 * Which process the printed job actually is. The installed service can keep a
 * launcher parent while the serving Gateway runs as its child, so `launchctl
 * print` reports the launcher's pid and a bare `pid === process.pid` test would
 * reject the enforcing job. Only this process and its immediate parent qualify;
 * anything else is a same-named job in another domain.
 */
function resolveJobRelation(pid: number | undefined): "self" | "launcher" | null {
  if (pid === undefined) {
    return null;
  }
  if (pid === process.pid) {
    return "self";
  }
  return pid === process.ppid ? "launcher" : null;
}

/**
 * The job's own `state`, which `launchctl print` puts at the top of the block at
 * a single tab. The shared key-value parser cannot supply it: nested coalition
 * blocks carry their own `state = active` lines and that parser keeps the last
 * occurrence. Read against the running Gateway LaunchDaemon, `state` appears three
 * times, the job's at one tab and two coalition lines at two tabs, and the parser
 * answers `active`.
 */
function readJobState(printed: string): string | undefined {
  return /^\tstate = (?<state>.+)$/mu.exec(printed)?.groups?.state?.trim();
}

/**
 * Whether launchd is the one stopping this job.
 *
 * launchd reports the job as `SIGTERMed` from the moment it begins its own stop,
 * and keeps reporting `running` while the process handles a signal that some
 * other sender delivered. Measured on macOS 27 against a job carrying
 * `ExitTimeOut` 47: `launchctl bootout` printed `state = SIGTERMed` from inside
 * the job's own SIGTERM handler and killed it at the 47 second mark, while a
 * plain `kill -TERM` printed `state = running` and left the process alive 85
 * seconds later, long past that deadline.
 *
 * Anything unrecognised counts as not stopping, so an unfamiliar state leaves the
 * Gateway on the budget it already had rather than shortening a drain that
 * launchd was never going to interrupt.
 */
function isLaunchdStoppingJob(state: string | undefined): boolean {
  return state !== undefined && /^SIG[A-Z0-9]+ed$/u.test(state);
}

/**
 * The stop deadline OpenClaw's Node recovery launcher armed for this process.
 *
 * The launcher does not announce it. It is derived here from the same shared
 * expression the launcher arms itself from, so the two cannot disagree and no build
 * of the launcher has to be new enough to tell the Gateway anything. That matters
 * because replacing files cannot change a launcher that is already running: the
 * first Gateway built from a given change is started by the previous launcher, and a
 * value that had to be declared would be missing exactly then, which is what would
 * let a long `ExitTimeOut` be budgeted past a force-kill the parent is already
 * counting down.
 *
 * Holding the parent slot proves nothing on its own, so this is gated on the respawn
 * markers that launcher stamps rather than on the parent relation: an external process
 * manager can start the Gateway from inside the same job and run no reap timer at all,
 * and that parent's deadline stays unreduced.
 */
function resolveParentLauncherStopTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  // One of these is set on every child the launcher respawns, and all of them predate
  // this deadline being derived, so a marker is present for a Gateway that launcher
  // started and absent for any other parent. An operator wrapper that keeps the job's
  // pid and starts the Gateway itself runs no such timer, and capping its deadline
  // would cut a drain nothing was going to interrupt.
  if (!isRespawnedByLauncher(env)) {
    return undefined;
  }
  return resolveLauncherStopTimeoutMs({
    env,
    platform: process.platform,
    // The launcher branched on its own argv, and it respawns the child with the same
    // user arguments, so testing ours reproduces the branch it took.
    foreground: isForegroundGatewayRunArgv(process.argv),
  });
}

/**
 * launchd is stopping the job, so a deadline is running, but its value could not
 * be read. `LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS` is both launchd's documented
 * default for a job omitting `ExitTimeOut` and the value OpenClaw's LaunchAgent
 * template writes. Guessing short only forfeits drain headroom; guessing long is
 * what lets the supervisor kill an unfinished drain.
 */
function defaultStopDeadline(target: string, reason: string): LaunchdStopRead {
  const timeoutMs = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
  return {
    stop: { timeoutMs, source: `launchd ${target} exit timeout unavailable; default ExitTimeOut` },
    warning: `launchd is stopping ${target} but ${reason}; using ${timeoutMs}ms default. Check the running job with launchctl print.`,
  };
}

/**
 * The job could not be inspected, so whether launchd is stopping it is unknown.
 *
 * No deadline is reported. Shortening the budget here would cut a drain that no
 * launchd deadline was bounding, and handing back the platform-neutral policy as
 * a launchd answer is worse than saying nothing: the caller would classify an
 * unverified number as a native stop budget, which caps a longer requested
 * restart drain and arms a forced exit on a stop launchd may not be running at
 * all. The caller already owns that policy number, so the warning alone is what
 * this adds, and it still routes the operator to the job.
 */
function unresolved(failures: string[]): LaunchdStopRead {
  return {
    stop: null,
    // Each failure already names the target it came from, and the label-resolution
    // case has no label to name, so the prefix deliberately carries neither.
    warning: `Unable to inspect the launchd job; ${failures
      .map((failure) => truncateUtf16Safe(failure.replaceAll(/\s+/g, " "), 500))
      .join("; ")}; keeping the Gateway stop policy. Check the running job with launchctl print.`,
  };
}

/**
 * Read the stop deadline launchd is enforcing on the Gateway's own running job.
 *
 * `ExitTimeOut` bounds a stop that launchd is running and nothing else, so it is
 * adopted only while the printed job reports launchd stopping it. An operator
 * job may set any value, so `LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS` is the fallback
 * rather than the answer. `stop` is null when this process is not a launchd job,
 * when launchd is not the one stopping it, and when the job could not be
 * inspected, each of which leaves the caller on the platform-neutral policy it
 * already resolved.
 */
export async function readLaunchdStopTimeout(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchdStopRead> {
  if (detectRespawnSupervisor(env, "darwin") !== "launchd") {
    return { stop: null };
  }
  const failures: string[] = [];
  let label: string;
  try {
    label = resolveLaunchAgentLabel(env);
  } catch (error: unknown) {
    return unresolved([`label could not be resolved: ${formatErrorMessage(error)}`]);
  }
  for (const target of resolveLaunchdDomains(label)) {
    const failed = (reason: string) => failures.push(`${target}: ${reason}`);
    const result = await execLaunchctl(["print", target], LAUNCHCTL_PRINT_TIMEOUT_MS).catch(
      (error: unknown) => {
        failed(`launchctl print threw: ${formatErrorMessage(error)}`);
        return undefined;
      },
    );
    if (!result) {
      continue;
    }
    if (result.code !== 0) {
      failed(`launchctl print exited ${result.code}: ${formatLaunchctlResultDetail(result)}`);
      continue;
    }
    const printed = result.stdout || result.stderr || "";
    const entries = parseKeyValueOutput(printed, "=");
    // Adopting a deadline from a same-named job in the other domain would be
    // worse than the fallback, so the printed job must be ours.
    const pid = parseStrictPositiveInteger(entries.pid ?? "");
    const relation = resolveJobRelation(pid);
    if (!relation) {
      failed(`pid ${pid ?? "missing"} is neither this process nor its launcher`);
      continue;
    }
    // This is our job, so stop searching. Whether its deadline binds this stop is
    // a separate question from whether the job was found.
    const state = readJobState(printed);
    if (!isLaunchdStoppingJob(state)) {
      // An absent or empty `state` reads exactly like a job launchd is not stopping, so the
      // Gateway would silently keep the platform-neutral policy on a macOS that
      // printed this block differently. A deadline parsed out of the same block is
      // what makes that indistinguishable case worth reporting: the job was found and
      // read, and only the one field this decision turns on went missing. It stays
      // "not stopping" rather than guessing the other way, because guessing would
      // shorten every externally signalled stop. Warning with no deadline also marks
      // the read inconclusive, so an in-process restart retains its startup budget
      // instead of treating this as a positive answer.
      // `!state` rather than an undefined test: the value is trimmed after matching, so
      // a line carrying only whitespace yields an empty string and would otherwise skip
      // the warning while behaving exactly like a missing one.
      return !state && entries["exit timeout"] !== undefined
        ? {
            stop: null,
            warning: `launchd ${target} printed an exit timeout but no job state, so it is treated as not stopping and the Gateway stop policy is kept. Check the running job with launchctl print.`,
          }
        : { stop: null };
    }
    const seconds = parseStrictPositiveInteger(entries["exit timeout"] ?? "");
    if (seconds === undefined) {
      return defaultStopDeadline(target, "its exit timeout is missing or invalid");
    }
    const jobMs = seconds * 1_000;
    // A parent that reaps this process on its own timer binds before the job's
    // ExitTimeOut, and spending the longer deadline would only get the drain
    // force-killed.
    const launcherMs =
      relation === "launcher" ? resolveParentLauncherStopTimeoutMs(env) : undefined;
    return launcherMs !== undefined && launcherMs < jobMs
      ? {
          stop: {
            timeoutMs: launcherMs,
            source: `launchd ${target} exit timeout capped at the launcher's ${launcherMs}ms stop timer`,
          },
        }
      : { stop: { timeoutMs: jobMs, source: `launchd ${target} exit timeout` } };
  }
  return unresolved(failures);
}
