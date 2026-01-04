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
