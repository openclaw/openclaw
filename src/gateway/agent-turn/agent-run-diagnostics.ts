import type { SubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type { DedupeEntry } from "../server-shared.js";
import { formatForLog } from "../ws-log.js";

/** Capture privacy once for command output, failure diagnostics, and later RPC replay. */
export function createAgentRunDiagnostics(
  sessionKey: string | undefined,
  isIncognitoEntry: boolean | undefined,
  log: Pick<SubsystemLogger, "warn">,
) {
  const incognito = isIncognitoEntry === true || isIncognitoSessionKey(sessionKey);
  const privateError = "Incognito agent error.";
  return {
    incognito,
    // Gateway console output is copied to disk; the RPC response owns live reply delivery.
    runtime: incognito ? { log() {}, error() {}, exit: defaultRuntime.exit } : defaultRuntime,
    warning: (message: string) => (error: unknown) =>
      log.warn(`${message}: ${incognito ? privateError : formatForLog(error)}`),
    forReplay: (entry: DedupeEntry): DedupeEntry =>
      incognito ? { ...entry, incognito: true } : entry,
    errorMeta: (message: string | undefined, includeError = true) => ({
      ...(message !== undefined && includeError
        ? { error: incognito ? privateError : message }
        : {}),
      ...(message !== undefined && incognito ? { errorMessage: privateError } : {}),
    }),
  };
}
