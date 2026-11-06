import { readdirSync, readFileSync } from "node:fs";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessCommand } from "@openclaw/proc-safe/inspect";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { readDarwinProcessCensus } from "./darwin-process-inspection.js";

/** Every command spawned under a durable reservation carries its name before exec. */
export const COMMAND_RESERVATION_ENV = "OPENCLAW_UPDATE_COMMAND_RESERVATION";

const CENSUS_TIMEOUT_MS = 5_000;

function readLinuxHolders(reservation: string): number[] {
  const needle = `${COMMAND_RESERVATION_ENV}=${reservation}\0`;
  const holders: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const environment = readFileSync(`/proc/${name}/environ`, "latin1");
      if (`\0${environment}`.includes(`\0${needle}`)) {
        holders.push(Number(name));
      }
    } catch (error) {
      // Exited tasks and other accounts' processes cannot be this Doctor's command.
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(extractErrorCode(error) ?? "")) {
        throw error;
      }
    }
  }
  return holders;
}

function readDarwinHolders(reservation: string): number[] {
  const holders: number[] = [];
  for (const member of readDarwinProcessCensus(CENSUS_TIMEOUT_MS)) {
    if (member.owner === "different" || member.state.startsWith("Z") || member.pid === 0) {
      continue;
    }
    try {
      const command = readProcessCommand(member.pid, {
        environmentKeys: [COMMAND_RESERVATION_ENV],
      });
      if (command?.environment[COMMAND_RESERVATION_ENV] === reservation) {
        holders.push(member.pid);
      }
    } catch (error) {
      // macOS withholds envp from hardened executables; only this PID stays unobserved.
      if (
        !(error instanceof ProcSafeError) ||
        !["incomplete", "layout-mismatch", "access-denied", "operation-failed"].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  return holders;
}

/**
 * PIDs still carrying a reservation's marker. Once its reserving process is dead no
 * new holder can appear, so an empty census stays true. Throws when unavailable.
 */
export function findCommandReservationHolders(reservation: string): number[] {
  if (process.platform === "linux") {
    return readLinuxHolders(reservation);
  }
  if (process.platform === "darwin") {
    return readDarwinHolders(reservation);
  }
  throw new Error(`Command reservation census is unavailable on ${process.platform}.`);
}
