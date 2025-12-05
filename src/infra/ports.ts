import net from "node:net";
import { danger, info, isVerbose, logVerbose, warn } from "../globals.js";
import { logDebug } from "../logger.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

export async function describePortOwner(
  port: number,
): Promise<string | undefined> {
  // Best-effort process info for a listening port (macOS/Linux).
  try {
    const { stdout } = await runExec("lsof", [
      "-i",
      `tcp:${port}`,
      "-sTCP:LISTEN",
      "-nP",
    ]);
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch (err) {
    logVerbose(`lsof unavailable: ${String(err)}`);
  }
  return undefined;
}

export async function ensurePortAvailable(port: number): Promise<void> {
  // Detect EADDRINUSE early with a friendly message.
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      const details = await describePortOwner(port);
      throw new PortInUseError(port, details);
    }
    throw err;
  }
}

export async function handlePortError(
  err: unknown,
  port: number,
  context: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
  // Uniform messaging for EADDRINUSE with optional owner details.
  if (
    err instanceof PortInUseError ||
    (isErrno(err) && err.code === "EADDRINUSE")
  ) {
    const details =
      err instanceof PortInUseError
        ? err.details
        : await describePortOwner(port);
    runtime.error(danger(`${context} failed: port ${port} is already in use.`));
    if (details) {
      runtime.error(info("Port listener details:"));
      runtime.error(details);
      if (/clawdis|src\/index\.ts|dist\/index\.js/.test(details)) {
        runtime.error(
          warn(
            "It looks like another clawdis instance is already running. Stop it or pick a different port.",
          ),
        );
      }
    }
    runtime.error(
      info(
        "Resolve by stopping the process using the port or passing --port <free-port>.",
      ),
    );
    runtime.exit(1);
  }
  runtime.error(danger(`${context} failed: ${String(err)}`));
  if (isVerbose()) {
    const stdout = (err as { stdout?: string })?.stdout;
    const stderr = (err as { stderr?: string })?.stderr;
    if (stdout?.trim()) logDebug(`stdout: ${stdout.trim()}`);
    if (stderr?.trim()) logDebug(`stderr: ${stderr.trim()}`);
  }
  return runtime.exit(1);
}

export { PortInUseError };
