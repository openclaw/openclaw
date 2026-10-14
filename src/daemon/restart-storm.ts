/** Detect repeated external CLI restarts across Gateway process lifetimes. */
import fs from "node:fs";
import { resolveGatewayRestartLogPath } from "./restart-logs.js";
import type { GatewayServiceEnv } from "./service-types.js";

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_THRESHOLD = 3;
const MAX_HISTORY_BYTES = 128 * 1024;
const WARNING_PREFIX = "openclaw gateway restart-storm warning ";

export type GatewayForcedRestartSummary = {
  count: number;
  windowMs: number;
  lastRestartAt?: string;
  lastWarningAt?: string;
};

export function readGatewayForcedRestartSummary(
  env: GatewayServiceEnv,
): GatewayForcedRestartSummary {
  const summary: GatewayForcedRestartSummary = { count: 0, windowMs: RESTART_WINDOW_MS };
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      resolveGatewayRestartLogPath(env),
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return summary;
    }
    const size = stat.size;
    const offset = Math.max(0, size - MAX_HISTORY_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_HISTORY_BYTES));
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let tail = buffer.toString("utf8", 0, length);
    if (offset > 0) {
      const newline = tail.indexOf("\n");
      tail = newline < 0 ? "" : tail.slice(newline + 1);
    }
    const now = Date.now();
    for (const line of tail.split("\n")) {
      const [, timestampText, body] = /^\[([^\]]+)\] (.*)$/.exec(line) ?? [];
      if (!timestampText || body === undefined) {
        continue;
      }
      const timestamp = Date.parse(timestampText);
      if (!Number.isFinite(timestamp) || timestamp <= now - RESTART_WINDOW_MS || timestamp > now) {
        continue;
      }
      const at = new Date(timestamp).toISOString();
      if (body.startsWith(WARNING_PREFIX)) {
        if (!summary.lastWarningAt || at > summary.lastWarningAt) {
          summary.lastWarningAt = at;
        }
      } else if (
        /^openclaw gateway lifecycle source=cli action=restart mode=(?:kickstart|bootout)(?: |$)/.test(
          body,
        )
      ) {
        // Reloads record bootout then bootstrap; count only the disruptive step.
        // Safe RPC and managed-tree handoffs have distinct source/mode fields.
        summary.count += 1;
        if (!summary.lastRestartAt || at > summary.lastRestartAt) {
          summary.lastRestartAt = at;
        }
      }
    }
  } catch {
    // Missing or unreadable diagnostic history must not prevent Gateway startup.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  return summary;
}

/** Emit once per window, retaining the warning in the existing restart log. */
export async function warnAboutGatewayRestartStorm(
  env: GatewayServiceEnv,
  warn: (message: string) => void,
): Promise<void> {
  let summary = readGatewayForcedRestartSummary(env);
  if (summary.count < RESTART_THRESHOLD || summary.lastWarningAt) {
    return;
  }
  const { findForeignLaunchdJobs } = await import("./launchd-foreign-jobs.js");
  const jobs = await findForeignLaunchdJobs(env).catch(() => []);
  // Inspection yields; a concurrent startup may already have reported this storm.
  summary = readGatewayForcedRestartSummary(env);
  if (summary.count < RESTART_THRESHOLD || summary.lastWarningAt) {
    return;
  }
  const likelyJobs = jobs
    .filter((job) => job.keepAlive && job.safeToRemove && job.gatewayActions.includes("restart"))
    .map((job) => job.label)
    .toSorted()
    .slice(0, 5);
  const message = [
    `Gateway restart storm: ${summary.count} external CLI restarts in 10 minutes.`,
    likelyJobs.length > 0
      ? `Likely stray launchd jobs: ${likelyJobs.join(", ")}.`
      : "Check for a stray keepalive launchd job invoking openclaw gateway restart.",
    "Run openclaw gateway status to inspect jobs and openclaw doctor --fix to remove eligible stray jobs.",
  ].join(" ");
  try {
    fs.appendFileSync(
      resolveGatewayRestartLogPath(env),
      `[${new Date().toISOString()}] ${WARNING_PREFIX}${message}\n`,
      "utf8",
    );
  } catch {
    // Still surface the warning when the diagnostic log cannot be written.
  }
  warn(message);
}
