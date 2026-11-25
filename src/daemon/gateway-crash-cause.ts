import { constants } from "node:os";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { GatewayCrashEvidence, GatewayCrashRecord } from "../infra/gateway-crash.js";
import { execFileUtf8 } from "./exec-file.js";

const PROCESS_EXIT_MESSAGE_ID = "98e322203f7a4ed290d09fe03c09fe15";
const INSPECTION_TIMEOUT_MS = 1_000;

/** Native evidence is optional; an absent journal never changes the recorded crash. */
export async function readGatewayCrashCause(
  crash: GatewayCrashRecord,
  env = process.env,
): Promise<GatewayCrashEvidence | undefined> {
  const supervisor = crash.supervisor;
  if (supervisor?.kind === "systemd" && supervisor.name) {
    const deadline = performance.now() + INSPECTION_TIMEOUT_MS;
    const readRows = async (since: number, until: number, matches: string[]) => {
      const timeout = Math.floor(deadline - performance.now());
      if (timeout <= 0) {
        return [];
      }
      const result = await execFileUtf8(
        "journalctl",
        [
          "--no-pager",
          "--output=json",
          "--lines=10",
          "--reverse",
          `--since=@${since / 1_000}`,
          `--until=@${until / 1_000}`,
          "--output-fields=__REALTIME_TIMESTAMP,MESSAGE_ID,MESSAGE,EXIT_CODE,EXIT_STATUS,_COMM,_PID,INVOCATION_ID,USER_INVOCATION_ID,_SYSTEMD_INVOCATION_ID",
          ...matches,
        ],
        { env, timeout },
      );
      return (result.code === 0 ? result.stdout.trim().split("\n") : []).flatMap((line) => {
        const row = safeParseJsonRecord(line);
        const timestamp = row?.["__REALTIME_TIMESTAMP"];
        if (!row || typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) {
          return [];
        }
        const atMs = Number(timestamp) / 1_000;
        const invocation =
          row.INVOCATION_ID ?? row.USER_INVOCATION_ID ?? row["_SYSTEMD_INVOCATION_ID"];
        return atMs >= since &&
          atMs <= until &&
          (!crash.systemdInvocationId || invocation === crash.systemdInvocationId)
          ? [{ row, atMs }]
          : [];
      });
    };
    // Manager exit records are indexed; never grep a process's entire lifetime.
    const exits = await readRows(crash.startedAtMs, crash.detectedAtMs, [
      `MESSAGE_ID=${PROCESS_EXIT_MESSAGE_ID}`,
      `UNIT=${supervisor.name}`,
      "+",
      `MESSAGE_ID=${PROCESS_EXIT_MESSAGE_ID}`,
      `USER_UNIT=${supervisor.name}`,
    ]);
    const evidence: GatewayCrashEvidence = {};
    let exitedAtMs: number | undefined;
    for (const { row, atMs } of exits) {
      const status = row.EXIT_STATUS;
      // systemd uses this message ID for control-command exits too. The bounded
      // row filter identifies the main process; only structured fields supply its cause.
      if (
        row["_COMM"] !== "systemd" ||
        row.MESSAGE_ID !== PROCESS_EXIT_MESSAGE_ID ||
        typeof row.MESSAGE !== "string" ||
        !row.MESSAGE.startsWith(`${supervisor.name}: Main process exited,`) ||
        typeof status !== "string" ||
        !/^\d+$/.test(status)
      ) {
        continue;
      }
      if (row.EXIT_CODE === "exited") {
        evidence.exitCode = Number(status);
      } else if (row.EXIT_CODE === "killed" || row.EXIT_CODE === "dumped") {
        evidence.signal = Object.entries(constants.signals).find(
          ([, value]) => value === Number(status),
        )?.[0];
      } else {
        continue;
      }
      exitedAtMs = atMs;
      evidence.uptimeMs = atMs - crash.startedAtMs;
      break;
    }
    // Stall recovery writes immediately before killing itself. Cap the fallback
    // window too: a stale heartbeat or delayed restart must not revive a day-long scan.
    const until = exitedAtMs ?? crash.detectedAtMs;
    const since = Math.max(crash.startedAtMs, crash.lastHeartbeatAtMs ?? 0, until - 30_000);
    const stalls = await readRows(since, until, [
      `--grep=^\\[gateway/event-loop\\] main-thread stall recovery: pid=${crash.pid} elapsedMs=\\d+ thresholdMs=\\d+ signal=SIGKILL$`,
      `_PID=${crash.pid}`,
      `_SYSTEMD_UNIT=${supervisor.name}`,
      "+",
      `_PID=${crash.pid}`,
      `_SYSTEMD_USER_UNIT=${supervisor.name}`,
    ]);
    if (stalls.length) {
      evidence.reason = "main-thread stall self-recovery";
    }
    return Object.keys(evidence).length ? evidence : undefined;
  }
  if (supervisor?.kind === "launchd" && supervisor.name) {
    const { readLaunchAgentRuntime, probeLaunchAgentState } = await import("./launchd-runtime.js");
    let runtime = await readLaunchAgentRuntime(
      { ...env, OPENCLAW_LAUNCHD_LABEL: supervisor.name },
      { timeoutMs: INSPECTION_TIMEOUT_MS },
    );
    const systemTarget = runtime.systemLaunchDaemon?.serviceTarget;
    if (systemTarget) {
      const probe = await probeLaunchAgentState(systemTarget, INSPECTION_TIMEOUT_MS);
      if (probe.state === "running" || probe.state === "stopped") {
        runtime = { ...runtime, ...probe.runtime };
      }
    }
    // launchd exposes no predecessor timestamp: retain its explicit observation,
    // never reinterpret an integer status as a Unix signal.
    return {
      ...(runtime.lastExitStatus !== undefined ? { exitCode: runtime.lastExitStatus } : {}),
      ...(runtime.lastExitReason ? { reason: runtime.lastExitReason } : {}),
    };
  }
  return undefined;
}
