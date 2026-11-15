import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";

/** Written once beside the release link; the service names it and it never changes. */
export const GIT_RELEASE_LAUNCHER = "openclaw-launcher.mjs";
/** The trial record the switch writes and the launcher and Gateway settle. */
export const GIT_RELEASE_TRIAL = ".trial";

/**
 * Whether a Git update runs from releases. POSIX only: #198835's link is POSIX-only, so
 * Windows checkouts and package-to-Git switches keep the in-place runner.
 */
export function usesGitReleases(switchToGit: boolean): boolean {
  return !switchToGit && process.platform !== "win32";
}

/**
 * A Git checkout install runs from releases on #198835's linked-root layout:
 * `<stateDir>/git-install/lib/node_modules/openclaw -> releases/<id>/lib/node_modules/openclaw`,
 * where each release is a detached worktree of the checkout. The checkout itself
 * is never the service path and an update never changes it.
 */
export function resolveGitReleasePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "git-install");
}

export function gitReleaseSlot(prefix: string): string {
  return path.join(packageReleaseGlobalRoot(prefix), "openclaw");
}

/** The release link's prefix when `entrypoint` starts through it, for the launcher. */
export function resolveGitReleaseLauncherForEntrypoint(entrypoint: string): string | null {
  const slot = path.dirname(path.dirname(path.resolve(entrypoint)));
  const prefix = path.dirname(path.dirname(path.dirname(slot)));
  return gitReleaseSlot(prefix) === slot && readPackageReleaseSlotSync(slot)
    ? path.join(prefix, GIT_RELEASE_LAUNCHER)
    : null;
}

/** The launcher's release entry, so service ownership reads the release it starts. */
export function resolveGitReleaseEntrypointForLauncher(entrypoint: string): string | null {
  return path.basename(entrypoint) === GIT_RELEASE_LAUNCHER
    ? path.join(gitReleaseSlot(path.dirname(entrypoint)), "dist", "index.js")
    : null;
}
