import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { listProcesses } from "@openclaw/proc-safe/inspect";
import { PinnedProcess } from "@openclaw/proc-safe/windows-job";

type WindowsProcessObservation = {
  pid: number;
  parentPid?: number;
  startIdentity?: string;
  commandLine?: string;
  executable?: string;
  cwd?: string;
  foreignOwner?: true;
  accessDenied?: true;
};

/** Missing fields never establish absence for same-user or unknown-owner work. */
export function readWindowsProcessCensus(timeoutMs: number): WindowsProcessObservation[] {
  return listProcesses({ timeoutMs, includeCommand: true }).flatMap(
    ({ pid, owner, identity, command }) => {
      if (pid === 0 || pid === 4 || identity?.exited) {
        return [];
      }
      let executable = command?.executable;
      if (!command && identity) {
        try {
          using pinned = PinnedProcess.open(pid, {
            access: "observe",
            expect: { startTimeMicros: identity.startTimeMicros },
          });
          executable = pinned?.imagePath;
        } catch {
          // Image names are best-effort diagnostics, never proof of non-custody.
        }
      }
      let accessDenied: true | undefined;
      if (owner === "unknown" && !identity && !command) {
        try {
          readProcessIdentity(pid);
        } catch (error) {
          // The census omits the reason for missing facts; only access denial
          // proves that a same-account, non-elevating handoff could not own it.
          if (error instanceof ProcSafeError && error.code === "access-denied") {
            accessDenied = true;
          }
        }
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
          ...(executable ? { executable } : {}),
          ...(command?.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(owner === "different" ? { foreignOwner: true as const } : {}),
          ...(accessDenied ? { accessDenied } : {}),
        },
      ];
    },
  );
}
