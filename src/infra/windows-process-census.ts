import { listProcesses } from "@openclaw/proc-safe/inspect";

type WindowsProcessObservation = {
  pid: number;
  parentPid?: number;
  startIdentity?: string;
  commandLine?: string;
  cwd?: string;
  foreignOwner?: true;
};

/** Missing fields never establish absence for same-user or unknown-owner work. */
export function readWindowsProcessCensus(timeoutMs: number): WindowsProcessObservation[] {
  return listProcesses({ timeoutMs, includeCommand: true }).flatMap(
    ({ pid, owner, identity, command }) => {
      if (pid === 0 || pid === 4 || identity?.exited) {
        return [];
      }
      return [
        {
          pid,
          ...(identity
            ? {
                parentPid: identity.parentPid,
                // Existing census/receipt identities are milliseconds since the Unix epoch.
                startIdentity: String(Math.floor(identity.startTimeMicros / 1000)),
              }
            : {}),
          ...(command?.commandLine === undefined ? {} : { commandLine: command.commandLine }),
          ...(command?.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(owner === "different" ? { foreignOwner: true as const } : {}),
        },
      ];
    },
  );
}
