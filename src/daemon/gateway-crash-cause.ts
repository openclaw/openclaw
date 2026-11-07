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
    const matches: string[] = [];
    for (const field of ["UNIT", "USER_UNIT", "_SYSTEMD_UNIT", "_SYSTEMD_USER_UNIT"]) {
      if (matches.length) {
        matches.push("+");
      }
      matches.push(`${field}=${supervisor.name}`);
    }
    const result = await execFileUtf8(
      "journalctl",
      [
        "--no-pager",
        "--output=json",
        "--lines=10",
        "--grep=: Main process exited,|\\[gateway/event-loop\\] main-thread stall recovery:",
        `--since=@${crash.startedAtMs / 1_000}`,
        `--until=@${crash.detectedAtMs / 1_000}`,
        "--output-fields=__REALTIME_TIMESTAMP,MESSAGE_ID,MESSAGE,EXIT_CODE,EXIT_STATUS,_COMM,_PID,INVOCATION_ID,USER_INVOCATION_ID,_SYSTEMD_INVOCATION_ID",
        ...matches,
      ],
      { env, timeout: INSPECTION_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      return undefined;
    }
    const evidence: GatewayCrashEvidence = {};
    for (const line of result.stdout.trim().split("\n")) {
      const row = safeParseJsonRecord(line);
      const timestamp = row?.["__REALTIME_TIMESTAMP"];
      if (!row || typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) {
        continue;
      }
      const atMs = Number(timestamp) / 1_000;
      const invocation =
        row.INVOCATION_ID ?? row.USER_INVOCATION_ID ?? row["_SYSTEMD_INVOCATION_ID"];
      if (
        atMs < crash.startedAtMs ||
        atMs > crash.detectedAtMs ||
        (crash.systemdInvocationId && invocation !== crash.systemdInvocationId)
      ) {
        continue;
      }
      if (
        row["_PID"] === String(crash.pid) &&
        typeof row.MESSAGE === "string" &&
        new RegExp(
          `^\\[gateway/event-loop\\] main-thread stall recovery: pid=${crash.pid} elapsedMs=\\d+ thresholdMs=\\d+ signal=SIGKILL$`,
        ).test(row.MESSAGE.trim())
      ) {
        evidence.reason = "main-thread stall self-recovery";
      }
      const status = row.EXIT_STATUS;
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
        evidence.uptimeMs = atMs - crash.startedAtMs;
      } else if (row.EXIT_CODE === "killed" || row.EXIT_CODE === "dumped") {
        evidence.signal = Object.entries(constants.signals).find(
          ([, value]) => value === Number(status),
        )?.[0];
        evidence.uptimeMs = atMs - crash.startedAtMs;
      }
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
