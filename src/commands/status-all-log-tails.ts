import {
  resolveGatewayLogPaths,
  resolveGatewayRestartLogPath,
  resolveGatewaySupervisorLogPaths,
} from "../daemon/restart-logs.js";
import { readFileTailLines } from "./status-all/gateway.js";

/** Reads the newest gateway log lines for the status --all report. */
export async function readStatusAllLogTails() {
  const logPaths = (() => {
    try {
      // macOS supervised installs write stdout/stderr differently than node-managed gateway logs.
      return process.platform === "darwin"
        ? resolveGatewaySupervisorLogPaths(process.env)
        : resolveGatewayLogPaths(process.env);
    } catch {
      return null;
    }
  })();
  if (logPaths) {
    const restartLogPath = resolveGatewayRestartLogPath(process.env);
    const readStderr = process.platform !== "darwin";
    const [stderrTail, stdoutTail, restartTail] = await Promise.all([
      readStderr ? readFileTailLines(logPaths.stderrPath, 40) : [],
      readFileTailLines(logPaths.stdoutPath, 40),
      readFileTailLines(restartLogPath, 30),
    ]);
    return { logPaths, restartLogPath, readStderr, stderrTail, stdoutTail, restartTail };
  }
  return null;
}
