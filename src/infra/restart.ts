import { spawnSync } from "node:child_process";

const DEFAULT_LAUNCHD_LABEL = "com.clawdbot.mac";
const DEFAULT_SYSTEMD_UNIT = "clawdbot-gateway.service";

export function triggerClawdbotRestart():
  | "launchctl"
  | "systemd"
  | "supervisor" {
  if (process.platform !== "darwin") {
    if (process.platform === "linux") {
      const unit = process.env.CLAWDBOT_SYSTEMD_UNIT || DEFAULT_SYSTEMD_UNIT;
      const userRestart = spawnSync("systemctl", ["--user", "restart", unit], {
        stdio: "ignore",
      });
      if (!userRestart.error && userRestart.status === 0) {
        return "systemd";
      }
      const systemRestart = spawnSync("systemctl", ["restart", unit], {
        stdio: "ignore",
      });
      if (!systemRestart.error && systemRestart.status === 0) {
        return "systemd";
      }
      return "systemd";
    }
    return "supervisor";
  }

  const label = process.env.CLAWDBOT_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid !== undefined ? `gui/${uid}/${label}` : label;
  spawnSync("launchctl", ["kickstart", "-k", target], { stdio: "ignore" });
  return "launchctl";
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal";
};

export function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
}): ScheduledRestart {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason =
    typeof opts?.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : undefined;
  const pid = process.pid;
  const hasListener = process.listenerCount("SIGUSR1") > 0;
  setTimeout(() => {
    try {
      if (hasListener) {
        process.emit("SIGUSR1");
      } else {
        process.kill(pid, "SIGUSR1");
      }
    } catch {
      /* ignore */
    }
  }, delayMs);
  return {
    ok: true,
    pid,
    signal: "SIGUSR1",
    delayMs,
    reason,
    mode: hasListener ? "emit" : "signal",
  };
}
