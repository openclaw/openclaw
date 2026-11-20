import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";

/** Written once beside the release link; the service names it and it never changes. */
export const GIT_RELEASE_LAUNCHER = "openclaw-launcher.mjs";
/** The trial record the switch writes and the launcher and Gateway settle. */
export const GIT_RELEASE_TRIAL = ".trial";

/**
 * Whether a Git update runs from releases. POSIX only: #198835's link is POSIX-only, so
 * Windows checkouts and package-to-Git switches keep the in-place runner. Only an installed
 * Gateway service that owns this install starts through the release link; a checkout run
 * by hand keeps the in-place runner, or its next start would run the old commit. The layout never
 * fails an update (#197949 decision 8): when it cannot be used, `onUnavailable` hears why
 * and the update takes the in-place runner. The next update tries the layout again.
 */
export function usesGitReleases(
  switchToGit: boolean,
  serviceOwnsInstall: boolean,
  onUnavailable?: (reason: string) => void,
): boolean {
  if (switchToGit || process.platform === "win32" || !serviceOwnsInstall) {
    return false;
  }
  const prefix = resolveGitReleasePrefix();
  const slot = gitReleaseSlot(prefix);
  try {
    fs.mkdirSync(path.join(prefix, PACKAGE_RELEASES_DIR), { recursive: true });
    if (fs.lstatSync(slot, { throwIfNoEntry: false }) && !readPackageReleaseSlotSync(slot)) {
      onUnavailable?.(`${slot} is not a release link`);
      return false;
    }
    return true;
  } catch (error) {
    onUnavailable?.(`${prefix} is unavailable: ${String(error)}`);
    return false;
  }
}

/**
 * A Git checkout install runs from releases behind a link:
 * `<stateDir>/git-install/openclaw -> releases/<id>/openclaw`, where each release is a
 * detached worktree of the checkout, built where it stays. The checkout itself is never the
 * service path and an update never changes it.
 */
export function resolveGitReleasePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "git-install");
}

export function gitReleaseSlot(prefix: string): string {
  return path.join(prefix, "openclaw");
}

/**
 * The link that serves now. Main builds from #199706 until this fix (which report version
 * 2026.11.5) kept the link and its releases at `lib/node_modules/openclaw`, where Node refuses to
 * strip the types of a release's plugin sources (#201874). That link serves until the next update
 * rebuilds the serving release outside it.
 */
export function servingGitReleaseSlot(prefix: string): string {
  const slot = gitReleaseSlot(prefix);
  const legacy = path.join(packageReleaseGlobalRoot(prefix), "openclaw");
  return !readPackageReleaseSlotSync(slot) && readPackageReleaseSlotSync(legacy) ? legacy : slot;
}

/** The release link's prefix when `entrypoint` starts through it, for the launcher. */
export function resolveGitReleaseLauncherForEntrypoint(entrypoint: string): string | null {
  const packagePath = path.dirname(path.dirname(path.resolve(entrypoint)));
  const slot =
    path.basename(packagePath) === "openclaw" ? readPackageReleaseSlotSync(packagePath) : null;
  return slot ? path.join(slot.prefix, GIT_RELEASE_LAUNCHER) : null;
}

/** The launcher's release entry, so service ownership reads the release it starts. */
export function resolveGitReleaseEntrypointForLauncher(entrypoint: string): string | null {
  return path.basename(entrypoint) === GIT_RELEASE_LAUNCHER
    ? path.join(servingGitReleaseSlot(path.dirname(entrypoint)), "dist", "index.js")
    : null;
}
