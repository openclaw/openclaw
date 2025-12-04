import { spawn } from "node:child_process";

const DEFAULT_LAUNCHD_LABEL = "com.steipete.clawdis";

export function triggerWarelayRestart(): void {
  const label =
    process.env.WARELAY_LAUNCHD_LABEL ||
    process.env.CLAWDIS_LAUNCHD_LABEL ||
    DEFAULT_LAUNCHD_LABEL;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid !== undefined ? `gui/${uid}/${label}` : label;
  const child = spawn("launchctl", ["kickstart", "-k", target], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
