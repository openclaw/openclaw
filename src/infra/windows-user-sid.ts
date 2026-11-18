import { spawnSync } from "node:child_process";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";

/** The launching token's account, independent of environment usernames or elevation. */
export function readWindowsUserSid(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const result = spawnSync(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    const sid = result.stdout?.trim();
    return !result.error && result.status === 0 && /^S-1-\d+(?:-\d+)+$/.test(sid) ? sid : undefined;
  } catch {
    return undefined;
  }
}
