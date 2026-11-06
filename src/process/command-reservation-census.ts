import { readdirSync, readFileSync } from "node:fs";
import { listProcesses } from "@openclaw/proc-safe/inspect";

// A reservation spawns within the same tick (agent tools: after a short admission await).
const BORN_AFTER_RESERVATION_MS = 15_000;
// Linux reports boot time in whole seconds.
const CLOCK_SLACK_MS = 2_000;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

type ProcessBirth = { pid: number; ppid?: number; bornAtMs?: number; zombie: boolean };

function readLinuxProcessBirths(): ProcessBirth[] {
  const bootSeconds = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
  if (!Number.isFinite(bootSeconds)) {
    throw new Error("Linux boot time is unavailable");
  }
  const uid = process.getuid?.();
  const births: ProcessBirth[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(
        readFileSync(`/proc/${name}/status`, "utf8"),
      );
      if (uids?.slice(1).some((id) => Number(id) === uid) !== true) {
        continue;
      }
      // comm may contain spaces and parentheses; the fields follow its final ")".
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      births.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        bornAtMs: bootSeconds * 1_000 + (Number(fields[19]) * 1_000) / LINUX_CLOCK_TICKS_PER_SECOND,
        zombie: fields[0] === "Z",
      });
    } catch {
      // The task exited during enumeration.
    }
  }
  return births;
}

function readDarwinProcessBirths(): ProcessBirth[] {
  return listProcesses({ timeoutMs: 5_000 }).flatMap((row) =>
    row.owner === "different"
      ? []
      : [
          {
            pid: row.pid,
            ppid: row.parentPid,
            bornAtMs: row.identity ? row.identity.startTimeMicros / 1_000 : undefined,
            zombie: row.state === "zombie",
          },
        ],
  );
}

/**
 * Same-account processes that may be the command an unbound reservation spawned: it
 * can only have started in the instant after reservation, and its spawner never got
 * to record which PID it was. Unreadable start times stay candidates. A dead spawner
 * starts nothing new, so an empty result stays true. Throws when no census is possible.
 */
export function findCommandReservationCandidates(reservedAtMs: number): number[] {
  const births =
    process.platform === "linux"
      ? readLinuxProcessBirths()
      : process.platform === "darwin"
        ? readDarwinProcessBirths()
        : undefined;
  if (!births) {
    throw new Error(`Command reservation census is unavailable on ${process.platform}.`);
  }
  // The inspecting command's own launchers are not the reserved command.
  const byPid = new Map(births.map((birth) => [birth.pid, birth]));
  const inspector = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !inspector.has(pid);) {
    inspector.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  return births
    .filter(
      ({ pid, bornAtMs, zombie }) =>
        !zombie &&
        !inspector.has(pid) &&
        (bornAtMs === undefined ||
          (bornAtMs >= reservedAtMs - CLOCK_SLACK_MS &&
            bornAtMs <= reservedAtMs + BORN_AFTER_RESERVATION_MS)),
    )
    .map(({ pid }) => pid);
}
