import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function canRunPlaywrightChromium(executablePath: string): boolean {
  // Chrome's --version exit path is POSIX-only; on Windows it hangs discovery.
  // Playwright owns the actual launch validation on Windows.
  return (
    existsSync(executablePath) &&
    (process.platform === "win32" ||
      spawnSync(executablePath, ["--version"], { stdio: "ignore" }).status === 0)
  );
}
