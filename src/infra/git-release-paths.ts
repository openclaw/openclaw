import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
 * The `openclaw.mjs` an npm global package holds once a Git install runs from releases. Its exact
 * text is how a later switch back to npm recognizes the package as this installation's.
 */
export function gitReleaseForwardingEntry(launcher: string): string {
  return `#!/usr/bin/env node\n// Starts the OpenClaw Git release that ${launcher} selects.\nawait import(${JSON.stringify(pathToFileURL(launcher).href)});\n`;
}

/** The package left intact by this install's npm-to-Git switch, including after fallback. */
export function isGitReleaseForwardingPackage(root: string, prefix: string): boolean {
  try {
    return (
      fs.readFileSync(path.join(root, "openclaw.mjs"), "utf8") ===
      gitReleaseForwardingEntry(path.join(prefix, GIT_RELEASE_LAUNCHER))
    );
  } catch {
    return false;
  }
}

/**
 * Every Git install updates through releases (on Windows the link is a junction). The layout
 * never refuses an update (#197949 decision 8): something other than a release link at the
 * package path is moved aside, and the returned warning names where. A Git checkout there (the
 * installer accepts any `--git-dir`) is a live installation that services and wrappers name, so
 * it stays; publication then refuses with the installation unchanged (rare, accepted). A state
 * directory that cannot hold `releases/` fails the update at its first write, naming the path.
 */
export function prepareGitReleaseLayout(): string | undefined {
  const slot = gitReleaseSlot(resolveGitReleasePrefix());
  const entry = fs.lstatSync(slot, { throwIfNoEntry: false });
  if (
    !entry ||
    readPackageReleaseSlotSync(slot) ||
    (entry.isSymbolicLink() && isGitReleaseForwardingPackage(slot, path.dirname(slot)))
  ) {
    return undefined;
  }
  if (fs.existsSync(path.join(slot, ".git"))) {
    return `${slot} is a Git checkout at the release link path, so Git releases cannot be published there; move the checkout (or reinstall with another --git-dir), then update again.`;
  }
  const aside = `${slot}.displaced-${Date.now()}`;
  try {
    fs.renameSync(slot, aside);
  } catch (error) {
    return `${slot} is not a release link and could not be moved aside (${String(error)}); remove it, then update again.`;
  }
  return `${slot} was not a release link; it was moved to ${aside}.`;
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
  if (path.basename(packagePath) !== "openclaw") {
    return null;
  }
  const prefix =
    readPackageReleaseSlotSync(packagePath)?.prefix ??
    // The link can name the npm package a switch keeps as its fallback.
    (isGitReleaseForwardingPackage(packagePath, path.dirname(packagePath))
      ? path.dirname(packagePath)
      : null);
  return prefix ? path.join(prefix, GIT_RELEASE_LAUNCHER) : null;
}

/** The launcher's release entry, so service ownership reads the release it starts. */
export function resolveGitReleaseEntrypointForLauncher(entrypoint: string): string | null {
  return path.basename(entrypoint) === GIT_RELEASE_LAUNCHER
    ? path.join(servingGitReleaseSlot(path.dirname(entrypoint)), "dist", "index.js")
    : null;
}

/**
 * The release entry that a converted Git checkout's `openclaw.mjs` or `dist/index.js` forwards
 * to. Git conversions keep a service written for the checkout; the update's forwarding marker
 * (`markForwarding` in `src/update/run.ts`) sends that entry to the launcher, and
 * `release-launcher-forward.mjs` follows the marker with the rules read here. Package trees
 * are left to their own service staging.
 */
export function resolveGitReleaseEntrypointForForwardingTree(entrypoint: string): string | null {
  const resolved = path.resolve(entrypoint);
  const tree =
    path.basename(resolved) === "openclaw.mjs"
      ? path.dirname(resolved)
      : path.basename(resolved) === "index.js" && path.basename(path.dirname(resolved)) === "dist"
        ? path.dirname(path.dirname(resolved))
        : null;
  if (!tree) {
    return null;
  }
  let root: string;
  try {
    root = fs.realpathSync(tree);
  } catch {
    return null;
  }
  // Only a checkout whose entries carry the forwarder runs the launcher instead of itself.
  if (
    !fs.existsSync(path.join(root, ".git")) ||
    !fs.existsSync(path.join(root, "release-launcher-forward.mjs"))
  ) {
    return null;
  }
  for (const marker of [
    path.join(root, ".openclaw-launcher"),
    path.join(root, ".git", "openclaw-launcher"),
  ]) {
    let launcher: string;
    try {
      launcher = fs.readFileSync(marker, "utf8").trim();
    } catch {
      continue;
    }
    if (!launcher || !fs.existsSync(launcher)) {
      continue;
    }
    // A release never forwards: it is what the launcher starts.
    if (root.startsWith(path.join(path.dirname(launcher), "releases") + path.sep)) {
      return null;
    }
    const release = resolveGitReleaseEntrypointForLauncher(launcher);
    return release && fs.existsSync(release) ? release : null;
  }
  return null;
}
