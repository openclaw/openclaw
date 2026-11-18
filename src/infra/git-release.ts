import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { sleep } from "../utils/sleep.js";
import { syncDirectoryIfSupported } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { writeGitReleaseLauncher, type GitReleaseTrial } from "./git-release-launcher.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { readPackageVersion } from "./package-json.js";
import { packageReleaseLeaseDir, readPackageReleaseLeases } from "./package-release-lease.js";
import { collectPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
  type PackageReleaseSlot,
} from "./package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  sweepPackageReleaseTemporaryLinks,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";

/**
 * A new release directory. The worktree is built at `buildDir`, outside
 * `node_modules` (Node refuses to strip types there), then moved to `releaseRoot`.
 */
export async function createGitReleaseDirs(prefix: string) {
  const releasePrefix = await createPackageReleasePrefix(prefix, "git");
  const globalRoot = packageReleaseGlobalRoot(releasePrefix);
  await fs.mkdir(globalRoot, { recursive: true });
  return {
    releasePrefix,
    buildDir: path.join(releasePrefix, "build"),
    releaseRoot: path.join(globalRoot, "openclaw"),
  };
}

const gitReleaseTrialFile = (prefix: string) =>
  path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);

const gitReleaseId = (prefix: string, root: string) =>
  path.relative(path.join(prefix, PACKAGE_RELEASES_DIR), root).split(path.sep)[0]!;

/**
 * Select `releaseRoot` with one rename. With `trial`, the launcher switches back
 * after two failed starts and the Gateway clears the record once it is ready.
 */
export async function publishGitRelease(params: {
  prefix: string;
  releaseRoot: string;
  trial: boolean;
  /** Leave the link to the next service start, which selects the release on trial. */
  pending?: boolean;
  assertCurrent?: () => void;
}): Promise<{ previous: string | null; target: string }> {
  const slot = gitReleaseSlot(params.prefix);
  const target = packageReleaseLinkTarget(slot, params.releaseRoot);
  const trialFile = gitReleaseTrialFile(params.prefix);
  await writeGitReleaseLauncher(params.prefix);
  const existing = await fs.lstat(slot).catch(ignoreMissingPath);
  let previous: string | null = null;
  if (existing) {
    const capture = await capturePackageReleaseSlot(slot);
    if (capture.kind !== "link") {
      throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
    }
    previous = capture.target;
    // A stale trial must not switch the next release back.
    await fs.rm(trialFile, { force: true });
    if (!params.pending) {
      await switchPackageReleaseLink({
        slot,
        expected: { identity: capture.identity, target: capture.target },
        target,
        assertCurrent: () => params.assertCurrent?.(),
      });
    }
  } else {
    const globalRoot = path.dirname(slot);
    await fs.mkdir(globalRoot, { recursive: true });
    await sweepPackageReleaseTemporaryLinks(globalRoot);
    const temporary = path.join(globalRoot, `.openclaw.release-link-${process.pid}-${Date.now()}`);
    await fs.symlink(target, temporary);
    params.assertCurrent?.();
    await fs.rename(temporary, slot);
    await syncDirectoryIfSupported(globalRoot);
  }
  if (params.trial && previous) {
    const buildId = await readBuiltGatewayBuildId(params.releaseRoot);
    const record: GitReleaseTrial = {
      target,
      previous,
      version: (await readPackageVersion(params.releaseRoot)) ?? "unknown",
      ...(buildId ? { buildId } : {}),
      // The update admits only a service whose config selection matches this process.
      config: resolveConfigPath(process.env),
      ...(params.pending ? { pending: true } : {}),
      createdAt: Date.now(),
      attempts: 0,
    };
    const temporary = `${trialFile}.${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(record));
    await fs.rename(temporary, trialFile);
  }
  return { previous, target };
}

async function readGitReleaseTrial(prefix: string): Promise<GitReleaseTrial | null> {
  const raw = await fs.readFile(gitReleaseTrialFile(prefix), "utf8").catch(ignoreMissingPath);
  // SAFETY: publishGitRelease and the launcher are the only writers of the trial record.
  return raw ? (JSON.parse(raw) as GitReleaseTrial) : null;
}

/** A ready Gateway ends the trial of the release it runs. */
export async function settleGitReleaseTrial(runningRoot: string | null): Promise<void> {
  const slot = runningRoot ? readPackageReleaseSlotSync(runningRoot) : null;
  if (!slot) {
    return;
  }
  const trial = await readGitReleaseTrial(slot.prefix);
  if (trial?.target === slot.target) {
    await fs.rm(gitReleaseTrialFile(slot.prefix), { force: true });
  }
}

export type GitReleasePlacement = {
  /** The release that last served and passed its trial: the trial fallback for the next switch. */
  serving: string;
  /** A release an earlier update placed whose trial never passed. */
  unserved?: {
    root: string;
    /** The link names it (the update failed after the switch), rather than a deferred trial. */
    selected: boolean;
    /** The launcher started it or a process holds it, so it may have served: never removed here. */
    mayHaveServed: boolean;
  };
};

/**
 * What the trial record says about the link. The link alone is not evidence of what
 * serves: an update that fails after the switch but before any Gateway starts the new
 * release leaves the link on a release that never served, with its trial still armed.
 * That trial's `previous` is the release that serves, and the next update builds on it.
 */
export async function readGitReleasePlacement(
  slot: PackageReleaseSlot,
): Promise<GitReleasePlacement> {
  const trial = await readGitReleaseTrial(slot.prefix).catch(() => null);
  const resolve = (target: string) =>
    fs.realpath(path.resolve(path.dirname(slot.slot), target)).catch(() => null);
  // The launcher counts every start of the release the link names on trial.
  const placed = (root: string, selected: boolean) => ({
    root,
    selected,
    mayHaveServed:
      (selected && trial!.attempts !== 0) ||
      readPackageReleaseLeases(slot.prefix, gitReleaseId(slot.prefix, root)).live > 0,
  });
  if (!trial) {
    return { serving: slot.releaseRoot };
  }
  if (trial.pending && trial.previous === slot.target) {
    const root = await resolve(trial.target);
    return root && root !== slot.releaseRoot
      ? { serving: slot.releaseRoot, unserved: placed(root, false) }
      : { serving: slot.releaseRoot };
  }
  const previous =
    !trial.pending && trial.target === slot.target ? await resolve(trial.previous) : null;
  return previous && previous !== slot.releaseRoot
    ? { serving: previous, unserved: placed(slot.releaseRoot, true) }
    : { serving: slot.releaseRoot };
}

/**
 * Remove a release this update superseded before it ever served: the link no longer
 * names it, the launcher never started it, and no process holds it. Anything else is
 * left to `collectGitReleases`.
 */
export async function discardUnservedGitRelease(params: {
  prefix: string;
  placement: GitReleasePlacement;
  prune: () => Promise<unknown>;
}): Promise<string | null> {
  const unserved = params.placement.unserved;
  const selected = readPackageReleaseSlotSync(gitReleaseSlot(params.prefix));
  if (!unserved || unserved.mayHaveServed || !selected || selected.releaseRoot === unserved.root) {
    return null;
  }
  const releasesDir = path.join(params.prefix, PACKAGE_RELEASES_DIR);
  const id = gitReleaseId(params.prefix, unserved.root);
  // Recheck at removal: a process may have started it since the placement was read.
  if (readPackageReleaseLeases(params.prefix, id).live > 0) {
    return null;
  }
  const releasePrefix = path.join(releasesDir, id);
  // Out of the release namespace first, so a partial removal is never a release.
  const doomed = path.join(releasesDir, `.collecting-${id}-${randomBytes(4).toString("hex")}`);
  await fs.rename(releasePrefix, doomed);
  await fs.rm(doomed, { recursive: true, force: true });
  await fs.rm(packageReleaseLeaseDir(releasesDir, id), { recursive: true, force: true });
  await params.prune();
  return releasePrefix;
}

/**
 * Remove releases the link does not name that are past the 24 hour minimum age
 * and unleased (#198835's rule), then let Git forget their worktrees.
 */
export async function collectGitReleases(params: {
  prefix: string;
  keep: readonly string[];
  prune: () => Promise<unknown>;
}): Promise<{ removed: string[]; warnings: string[] }> {
  const collected = await collectPackageReleases({
    slot: gitReleaseSlot(params.prefix),
    prefix: params.prefix,
    keep: params.keep,
  });
  if (collected.removed.length > 0) {
    await params.prune();
  }
  return collected;
}

/**
 * The serving Gateway restarts itself once its maintenance tick (30 s) sees the link
 * move. Wait for a new Gateway owner before verifying; after 35 s, ask it to restart
 * (SIGUSR2), which also covers a plugin-only restart where the link did not move.
 */
export async function waitForGitReleaseSuccessor(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const ownerPid = () => {
    try {
      return readGatewayOwnerLease({ env, current: true })?.pid;
    } catch {
      return undefined;
    }
  };
  const servingPid = ownerPid();
  for (let waited = servingPid ? 0 : 90; waited < 90; waited++) {
    if (waited === 35) {
      try {
        process.kill(servingPid!, "SIGUSR2");
      } catch {
        // A Gateway that already exited has a successor coming.
      }
    }
    await sleep(1_000, signal);
    if (ownerPid() !== servingPid) {
      return;
    }
  }
}
