import { runCommandWithTimeout } from "../process/exec.js";
import { isWSLSync } from "./wsl.js";

export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: Array<{ argv: string[] }> = [
    { argv: ["pbcopy"] },
    { argv: ["xclip", "-selection", "clipboard"] },
    { argv: ["wl-copy"] },
    // On WSL, Node's spawn() cannot invoke Windows PE executables directly
    // (ENOENT or SIGTERM). Route through the shell so binfmt_misc interop
    // can handle clip.exe with piped stdin.
    isWSLSync() ? { argv: ["sh", "-c", "cat | clip.exe"] } : { argv: ["clip.exe"] },
    { argv: ["powershell", "-NoProfile", "-Command", "Set-Clipboard"] },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        timeoutMs: 3_000,
        input: value,
      });
      if (result.code === 0 && !result.killed) {
        return true;
      }
    } catch {
      // keep trying the next fallback
    }
  }
  return false;
}
