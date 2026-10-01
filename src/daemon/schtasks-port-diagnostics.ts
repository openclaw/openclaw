import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";

export async function describeUnverifiedPortListeners(
  port: number,
  probeHosts?: readonly string[],
): Promise<string> {
  const diagnostics = await inspectPortUsage(port, probeHosts ? { probeHosts } : undefined).catch(
    () => null,
  );
  const listeners = diagnostics?.status === "busy" ? diagnostics.listeners : [];
  if (!listeners || listeners.length === 0) {
    return "";
  }
  const described = listeners.map((listener) => {
    const pid = typeof listener.pid === "number" ? listener.pid : null;
    const argv = listener.commandLine ? parseWindowsNativeCommandLine(listener.commandLine) : null;
    const identity = argv
      ? classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw"
        ? "openclaw gateway"
        : "not an openclaw gateway"
      : "argv unavailable";
    const name = listener.command ?? "unknown";
    return pid ? `pid ${pid} (${name}, ${identity})` : `${name} (${identity})`;
  });
  const pids = listeners
    .map((listener) => listener.pid)
    .filter((pid): pid is number => typeof pid === "number");
  const hint = pids.length
    ? ` If one of these is this gateway, stop it with "Stop-Process -Id <pid> -Force" and retry.`
    : "";
  return ` Remaining listener(s): ${described.join(", ")}. If gateway.cmd redirects output, quote the entire redirection target, including environment variables.${hint}`;
}
