import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolveLsofCommandSync } from "./ports-lsof.js";

/**
 * Find PIDs of gateway processes listening on the given port by inspecting process argv.
 * This is more reliable than findGatewayPidsOnPortSync when the gateway is running
 * under `node` (e.g. npm global installs).
 */
export function findVerifiedGatewayListenerPidsOnPortSync(port: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const lsof = resolveLsofCommandSync();
  const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
    timeout: 2000,
  });

  if (res.status !== 0 || !res.stdout) {
    return [];
  }

  const pids = res.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("p"))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

  const verifiedPids: number[] = [];

  for (const pid of pids) {
    const argv = getProcessArgvSync(pid);
    if (argv.some((arg) => arg.toLowerCase().includes("openclaw"))) {
      verifiedPids.push(pid);
    }
  }

  return [...new Set(verifiedPids)];
}

function getProcessArgvSync(pid: number): string[] {
  if (process.platform === "linux") {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // cmdline is null-terminated
      return cmdline.split("\0").filter(Boolean);
    } catch {
      return [];
    }
  }

  if (process.platform === "darwin") {
    try {
      const res = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 1000,
      });
      if (res.status === 0) {
        return res.stdout.trim().split(/\s+/);
      }
    } catch {
      // ignore
    }
  }

  return [];
}
