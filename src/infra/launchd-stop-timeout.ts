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

// A warning without a deadline means inspection was inconclusive. Only a
// confirmed launchd stop or our launcher's independent reap timer yields a
// native budget; the caller owns the fallback policy.
export type LaunchdStopRead = { stop: LaunchdStopTimeout | null; warning?: string };

const LAUNCHCTL_PRINT_TIMEOUT_MS = 2_000;

// Check all domains: a service account may lack a GUI session, and a matching
// label in a different domain must not supply this process's deadline.
function resolveLaunchdDomains(label: string): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  // A LaunchDaemon and a LaunchAgent can carry the same label in different
  // domains, so each is a candidate and the pid decides which one is ours.
  // A service account with no logged-in session has no gui domain at all, and
  // its per-user jobs live in `user/<uid>`, so both user domains are checked.
  return [`system/${label}`, `gui/${uid}/${label}`, `user/${uid}/${label}`];
}

// launchctl can report the Gateway or a launcher parent that holds the job PID.
function resolveJobRelation(pid: number | undefined): "self" | "launcher" | null {
  if (pid === undefined) {
    return null;
  }
  if (pid === process.pid) {
    return "self";
  }
  return pid === process.ppid ? "launcher" : null;
}

// Nested coalition blocks also contain state: use the single-tab job field,
// not the last state selected by the generic key-value parser.
function readJobState(printed: string): string | undefined {
  return /^\tstate = (?<state>.+)$/mu.exec(printed)?.groups?.state?.trim();
}

// launchd reports SIGTERMed during bootout/kickstart, but keeps running on an
// externally delivered SIGTERM. Only the former starts ExitTimeOut's clock.
function isLaunchdStoppingJob(state: string | undefined): boolean {
  return state !== undefined && /^SIG[A-Z0-9]+ed$/u.test(state);
}

// A respawn marker, not parenthood alone, proves the launcher runs a reap timer.
// Derive that timer from the same shared expression: an already-running parent
// cannot be taught a new announced deadline by upgrading the child.
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

// The job is stopping but its value is missing; use launchd's 20s default.
function defaultStopDeadline(target: string, reason: string): LaunchdStopRead {
  const timeoutMs = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
  return {
    stop: { timeoutMs, source: `launchd ${target} exit timeout unavailable; default ExitTimeOut` },
    warning: `launchd is stopping ${target} but ${reason}; using ${timeoutMs}ms default. Check the running job with launchctl print.`,
  };
}

// Unknown ownership of the stop cannot justify shortening a potentially
// unconstrained drain. Warn, but leave the caller's policy authoritative.
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

// Read the loaded job only on shutdown. Its ExitTimeOut applies only while
// launchd stops it; a respawn launcher can enforce an independent deadline.
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
    const launcherMs =
      relation === "launcher" ? resolveParentLauncherStopTimeoutMs(env) : undefined;
    const state = readJobState(printed);
    if (!isLaunchdStoppingJob(state)) {
      // A direct signal to the Gateway starts neither launchd's clock nor its
      // parent launcher's timer. Node cannot identify the sender, so capping on
      // the parent marker would truncate that supported long drain. A signal
      // forwarded by the launcher is indistinguishable here (existing limitation).
      return !state && entries["exit timeout"] !== undefined
        ? {
            stop: null,
            warning: `launchd ${target} printed an exit timeout but no job state, so it is treated as not stopping and the Gateway stop policy is kept. Check the running job with launchctl print.`,
          }
        : { stop: null };
    }
    const rawSeconds = entries["exit timeout"]?.trim();
    if (rawSeconds === "0") {
      return launcherMs !== undefined
        ? {
            stop: {
              timeoutMs: launcherMs,
              source: `launchd ${target} unlimited exit timeout capped at the launcher's ${launcherMs}ms stop timer`,
            },
          }
        : { stop: { timeoutMs: Infinity, source: `launchd ${target} unlimited exit timeout` } };
    }
    const seconds = parseStrictPositiveInteger(rawSeconds ?? "");
    if (seconds === undefined) {
      return defaultStopDeadline(target, "its exit timeout is missing or invalid");
    }
    const jobMs = seconds * 1_000;
    // A parent that reaps this process on its own timer binds before the job's
    // ExitTimeOut, and spending the longer deadline would only get the drain
    // force-killed.
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
