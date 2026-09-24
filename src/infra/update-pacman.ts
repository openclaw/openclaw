import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasNodeErrorCode } from "./path-guards.js";

export type PacmanOwnership = {
  manager: "pacman";
  packageName: string;
  nextAction: string;
};

export class PacmanOwnershipError extends Error {
  constructor(
    readonly root: string,
    readonly ownership?: PacmanOwnership,
  ) {
    super(
      ownership
        ? `This OpenClaw installation is managed by pacman (${ownership.packageName}). ${ownership.nextAction}`
        : "Pacman ownership could not be verified. Check access to the pacman database and run pacman -Qo on the installation files and launcher before retrying.",
    );
    this.name = "PacmanOwnershipError";
  }

  get reason(): string {
    return this.ownership ? "unmanaged-package-install" : "pacman-ownership-unavailable";
  }
}

/** Query installed ownership, never repository freshness or write permissions. */
export async function inspectPacmanOwnership(
  root: string | null | undefined,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  additionalEntries: readonly string[] = [],
): Promise<PacmanOwnership | null> {
  if (process.platform !== "linux" || !root) {
    return null;
  }
  signal?.throwIfAborted();
  try {
    await fs.access("/usr/bin/pacman", fs.constants.X_OK);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw new PacmanOwnershipError(root);
  }
  for (const entry of [
    path.resolve(root, "package.json"),
    path.resolve(root, "openclaw.mjs"),
    ...additionalEntries,
  ]) {
    signal?.throwIfAborted();
    let file: string;
    try {
      await fs.lstat(entry);
      // Pacman owns the symlink entry, not an unrelated referent.
      file = path.join(await fs.realpath(path.dirname(entry)), path.basename(entry));
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw new PacmanOwnershipError(root);
    }
    let result;
    try {
      result = await runCommandWithTimeout(["/usr/bin/pacman", "-Qqo", "--", file], {
        timeoutMs,
        signal,
        killProcessTree: true,
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (hasNodeErrorCode(error, "ENOENT")) {
        return null;
      }
      throw new PacmanOwnershipError(root);
    }
    signal?.throwIfAborted();
    const packageName = result.stdout.trim();
    if (
      result.termination === "exit" &&
      result.code === 0 &&
      /^[a-zA-Z0-9@_+][a-zA-Z0-9@._+-]*$/.test(packageName)
    ) {
      return {
        manager: "pacman",
        packageName,
        nextAction:
          "Use your distribution's update workflow (on Arch Linux: sudo pacman -Syu), then run openclaw gateway restart.",
      };
    }
    // Exit 1 also covers database/config failures; only the explicit negative
    // ownership result permits an npm probe. Keep unexpected failures visible.
    if (
      result.termination === "exit" &&
      result.code === 1 &&
      !packageName &&
      result.stderr.trim() === `error: No package owns ${file}`
    ) {
      continue;
    }
    throw new PacmanOwnershipError(root);
  }
  return null;
}

export async function assertPacmanUnowned(
  root: string | null | undefined,
  timeoutMs?: number,
  additionalEntries: readonly string[] = [],
): Promise<void> {
  const ownership = await inspectPacmanOwnership(root, timeoutMs, undefined, additionalEntries);
  if (ownership && root) {
    throw new PacmanOwnershipError(root, ownership);
  }
}
