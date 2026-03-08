/**
 * Warns if the OpenClaw config directory is inside a git repository.
 *
 * T-ACCESS-003: tokens stored in plaintext in ~/.openclaw/openclaw.json.
 * If a user accidentally commits their config directory, tokens are
 * pushed to a remote and become compromised.
 *
 * Runs once at startup. Prints a warning, does not block.
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    if (existsSync(resolve(dir, ".git"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

export function checkConfigInGitRepo(configDir: string): void {
  const gitRoot = findGitRoot(configDir);
  if (gitRoot) {
    console.warn(
      `[security] WARNING: OpenClaw config directory is inside a git repo (${gitRoot}).` +
        ` Tokens in openclaw.json may be committed. Add .openclaw/ to .gitignore.`,
    );
  }
}
