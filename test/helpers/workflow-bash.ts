import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function resolveWorkflowBash(): string {
  // Ubuntu uses Bash 5; Apple's Bash 3 does not honor errexit for failed [[ ]] guards.
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, "bash");
    if (!existsSync(candidate)) {
      continue;
    }
    const result = spawnSync(
      candidate,
      ["--noprofile", "--norc", "-c", 'test "${BASH_VERSINFO[0]}" -ge 5'],
      { stdio: "ignore", timeout: 1_000 },
    );
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error("Linux workflow tests require Bash 5+. Install Bash 5+ and put it on PATH.");
}
