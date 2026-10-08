import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { runExec } from "../process/exec.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

const INSPECTION_TIMEOUT_MS = 2_000;
const MANUAL_INSPECTION =
  "Inspect `ps -axo pid,ppid,args | grep '[t]ailscale'`; after confirming the claimant, use `kill -TERM <confirmed-pid>` (or `sudo kill -TERM <confirmed-pid>` for a root process). ";

function normalizedProxy(target: string): string | undefined {
  try {
    const url = new URL(/^\d+$/.test(target) ? `http://127.0.0.1:${target}` : target);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function matchesRoute(argv: string[], port: number, proxy: string | undefined): boolean {
  if (
    path.basename(argv[0] ?? "").toLowerCase() !== "tailscale" ||
    (argv[1] !== "serve" && argv[1] !== "funnel") ||
    argv.includes("--bg") ||
    argv.includes("--bg=true")
  ) {
    return false;
  }
  const portFlag = argv.find((arg) => arg.startsWith("--https="));
  const portIndex = argv.indexOf("--https");
  const httpsPort =
    portFlag?.slice("--https=".length) ?? (portIndex < 0 ? "443" : argv[portIndex + 1]);
  const target = argv.at(-1);
  const normalizedTarget = target === undefined ? undefined : normalizedProxy(target);
  return (
    Number(httpsPort) === port &&
    proxy !== undefined &&
    normalizedTarget !== undefined &&
    normalizedTarget === normalizedProxy(proxy)
  );
}

/** A Serve status session has no PID; matching commands remain operator-confirmed candidates. */
export async function readTailscaleRouteProcessDiagnostics(
  port: number,
  proxy: string | undefined,
) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return "Inspect running Tailscale Serve/Funnel processes and stop only the confirmed claimant. ";
  }
  try {
    const { stdout } = await runExec("ps", ["-axo", "pid=,uid=,comm="], {
      timeoutMs: INSPECTION_TIMEOUT_MS,
      maxBuffer: 512_000,
      logOutput: false,
      baseEnv: resolveDiagnosticProcessEnv(),
    });
    const candidates: string[] = [];
    const deadline = Date.now() + INSPECTION_TIMEOUT_MS;
    for (const line of stdout.split("\n")) {
      if (Date.now() >= deadline || candidates.length >= 10) {
        break;
      }
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match || path.basename(match[3]!).toLowerCase() !== "tailscale") {
        continue;
      }
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        continue;
      }
      const argv = readGatewayLockProcessCmdline(pid, process.platform, INSPECTION_TIMEOUT_MS);
      if (!argv || !matchesRoute(argv, port, proxy)) {
        continue;
      }
      const command = sanitizeForLog(argv.map(redactSensitiveUrlLikeString).join(" ")).slice(
        0,
        512,
      );
      const sudo = Number(match[2]) === process.getuid?.() ? "" : "sudo ";
      candidates.push(
        `PID ${pid}: ${command}. Recheck with \`ps -p ${pid} -o pid,ppid,user,args\`; only after confirming it owns this route, run \`${sudo}kill -TERM ${pid}\`.`,
      );
    }
    return candidates.length
      ? `Candidate processes matching the HTTPS port and proxy target (ownership unproven): ${candidates.join(" ")} Verify the foreground session disappears before restarting the Gateway. `
      : `No matching claimant PID could be identified. ${MANUAL_INSPECTION}`;
  } catch {
    return `Claimant process inspection was unavailable. ${MANUAL_INSPECTION}`;
  }
}
